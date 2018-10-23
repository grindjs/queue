import './BaseDriver'
import '../Support/SQS'

/**
 * AWS Simple Queue Service (SQS) backed Queue Driver
 */
export class SQSDriver extends BaseDriver {
	client = null

	constructor(app, config) {
		super(app, config)

		this.client = new SQS(config)
	}

	ready() {
		return this.client.createQueue()
	}

	connect() {
		return Promise.resolve()
	}

	async dispatch(job) {
		const payload = this.buildPayload(job)
		const queueUrl = this.client.queueUrls[payload.queue]

		if(queueUrl.isNil) {
			return Promise.reject(`Unable to find SQS url for job queue ${payload.queue}`)
		}

		const params = {
			QueueUrl: queueUrl,
			MessageBody: JSON.stringify(payload)
		}

		if(payload.delay > 0) {
			params.DelaySeconds = Math.round(payload.delay / 1000)
		}

		return this.client.put(params)
	}

	listen(queues, concurrency, jobHandler, errorHandler) {
		// SQS can batch ingest up to 10 jobs in a single call
		const concurrentListens = Math.ceil(concurrency / 10)
		const remainderJobConcurrency = 10 - ((concurrentListens * 10) - concurrency)

		const listeners = [ ]

		for(let i = 0; i < concurrentListens; i++) {
			for(const queue of queues) {
				let concurrentJobs = 10

				if(i === (concurrentListens - 1)) {
					concurrentJobs = remainderJobConcurrency
				}

				listeners.push(this._listen(queue, concurrentJobs, jobHandler, errorHandler))
			}
		}

		return Promise.all(listeners)
	}

	_listen(queue, concurrency, jobHandler, errorHandler) {
		return this.client.watch(queue, concurrency, async function callback(jobData, dispatchedAt, pastTries = 1) {
			const job = JSON.parse(jobData)
			const isExpired = timeout => {
				return (timeout !== 0) && ((new Date - dispatchedAt) > timeout)
			}

			try {
				if(isExpired(job.timeout)) {
					return
				}

				await jobHandler(job)
			} catch(err) {
				try {
					const tries = Number.parseInt(job.tries) || 1

					if((pastTries >= tries) || isExpired(job.timeout)) {
						throw err
					}

					if(job.retry_delay > 0) {
						await new Promise(resolve => {
							return setTimeout(() => {
								return resolve()
							}, job.retry_delay)
						})
					}
				} catch(err) {
					return errorHandler(job, err)
				}

				return callback(jobData, dispatchedAt, pastTries += 1)
			}
		})
	}

	destroy() {
		this.client.isShutdown = true
		this.client.constructor.queueUrls = { }
		return super.destroy()
	}

}
