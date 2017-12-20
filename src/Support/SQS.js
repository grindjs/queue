import { MissingPackageError } from 'grind-framework'

let sqs = null

/**
 * Loads the aws-sdk package or throws an error
 * if it hasn‘t been added
 */
function loadPackage() {
	if(!sqs.isNil) {
		return
	}

	try {
		sqs = require('aws-sdk').SQS
	} catch(err) {
		throw new MissingPackageError('aws-sdk')
	}
}

/**
 * Wrapper around AWS SQS to provide a
 * promise based interface + simplifies a few ops
 */
export class SQS {

	static queueUrls = { }

	get queueUrls() {
		return this.constructor.queueUrls
	}

	client = null
	queueConfigs = null

	constructor(config) {
		loadPackage()
		this.queueConfigs = config.queues

		const serviceConfig = {
			region: config.region || 'us-east-1'
		}

		// NOTE preferred way to access SQS is via an AWS IAM role
		if(!config.access_key.isNil && !config.secret_key.isNil) {
			serviceConfig.accessKeyId = config.access_key
			serviceConfig.secretAccessKey = config.secret_key
		}

		this.client = new sqs(serviceConfig)
	}

  /*
		To create queues, use the `queues` object via the config:
		"connections": {
			"sqs-connection": {
				"driver": "sqs",
				"queues": {
					"test-queue-name": { ...queue options here },
					"test-queue-name2": { "QueueUrl": "https://sqs.us-east-1..." }
				}
			}
		}

		On app start, grind-queue calls AWS to create/update your queues as necessary and grab the URLs.
		For any queue options not specified, we'll use the AWS defaults.
		The queue name `default` is reserved for setting queue defaults different from AWS's.

		If you want to use an SQS queue managed without grind-queue, set the QueueUrl option.
		Grind-queue will use that url and, on startup, will skip the inital calls to AWS.
	*/
	async createQueue() {
		for(const [ name, queueAttributes ] of Object.entries(this.queueConfigs)) {
			// `default` queue name is reserved for setting new defaults
			if(name === 'default') {
				continue
			}

			// If QueueUrl option is set, simply use the url
			if(!queueAttributes.QueueUrl.isNil) {
				this.queueUrls[name] = queueAttributes.QueueUrl
				continue
			}

			const defaultAttributes = Object.assign({
				// AWS defaults - set explicitly here to ovveride changes made via SQS console/cli
				DelaySeconds: '0',
				MaximumMessageSize: '262144',
				MessageRetentionPeriod: '345600',
				ReceiveMessageWaitTimeSeconds: '0',
				VisibilityTimeout: '30'
			}, (this.queueConfigs.default || { }))

			const params = {
				QueueName: name,
				Attributes: {
					...Object.assign(defaultAttributes, queueAttributes)
				}
			}

			await new Promise((res, rej) => this.findOrCreateQueue(res, rej, name, params))
		}
	}

	async findOrCreateQueue(resolve, reject, name, params) {
		let queueUrl = params.QueueUrl

		if(!queueUrl.isNil) {
			// set remote url for queue
			this.queueUrls[name] = queueUrl
			return resolve()
		}

		try {
			queueUrl = await new Promise((resolve2, reject2) => {
				return this.client.createQueue(params, async (err, data) => {
					if(!err.isNil && (err.code === 'QueueAlreadyExists')) {
						// error triggered when remote queue exists but config and remote attributes differ
						await this.findAndUpdateQueue(params)
						return resolve2(params.QueueUrl)
					} else if(!err.isNil) {
						return reject2(err)
					}

					// resolves here if queue is created -or- queue exists and config and remote attributes match
					return resolve2(data.QueueUrl)
				})
			})
		} catch(err) {
			return reject(err)
		}

		// set remote url for queue
		this.queueUrls[name] = queueUrl
		return resolve()
	}

	async findAndUpdateQueue(params) {
		// Set queue url then update queue attributes
		params.QueueUrl = await new Promise((resolve, reject) => {
			return this.client.getQueueUrl({ QueueName: params.QueueName }, (err, data) => {
				return err.isNil ? resolve(data.QueueUrl) : reject(err)
			})
		})

		return new Promise((resolve, reject) => {
			delete params.QueueName

			return this.client.setQueueAttributes(params, err /* ,data */ => {
				return err.isNil ? resolve() : reject(err)
			})
		})
	}

	put(params) {
		return new Promise((resolve, reject) => {
			return this.client.sendMessage(params, (err, data) => {
				return err.isNil ? resolve(data) : reject(err)
			})
		})
	}

	async watch(queue, concurrency, handler) {
		const queueUrl = this.queueUrls[queue]

		if(queueUrl.isNil) {
			throw new Error(`Queue url not found ${queue}`)
		}

		const params = {
			QueueUrl: queueUrl,
			MaxNumberOfMessages: concurrency,
			// VisibilityTimeout: 30  - set via queue-wide VisibilityTimeout
			WaitTimeSeconds: 20,
			AttributeNames: [ 'SentTimestamp' ]
		}

		const messages = await new Promise(resolve => {
			return this.client.receiveMessage(params, (err, data) => {
				if(err) {
					return resolve()
				} else if((data.Messages === void 0) || (data.Messages.length === 0)) {
					return resolve()
				}

				return resolve(data.Messages)
			})
		})

		if(Array.isArray(messages)) {
			// Delete jobs from SQS so they are not reprocessed, then process them
			await this.deleteFromQueue(queueUrl, messages)
			await Promise.all(messages.filter(message => message.isDeleted).map(message => {
				const messageData = message.Body
				const dispatchedAt = new Date(message.Attributes.SentTimestamp)

				return handler(messageData, dispatchedAt)
			}))
		}

		// Once finished processing current jobs, re-watch the queue
		return this.watch(queue, concurrency, handler)
	}

	async deleteFromQueue(url, messages) {
		const params = {
			QueueUrl: url,
			Entries: messages.map((message, i) => {
				return {
					Id: `${i}`,
					ReceiptHandle: message.ReceiptHandle
				}
			})
		}

		try {
			await new Promise((resolve, reject) => {
				return this.client.deleteMessageBatch(params, (err, data) => {
					if(!err.isNil) {
						return reject(err)
					}

					for(const result of data.Successful) {
						messages[result.Id].isDeleted = true
					}

					if(data.Failed.length > 0) {
						const failed = data.Failed
						const mssg = failed.map(result => `{senderFault: ${result.SenderFault}, code: ${result.Code}}`)

						Log.error(
							`Failed to delete ${failed.length} messasges. Releasing back into queue. Error ${mssg}`
						)
					}

					return resolve()
				})
			})
		} catch(err) {
			Log.error(`Failed to delete messasges. Releasing back into queue. Error ${err}`)
		}
	}

}
