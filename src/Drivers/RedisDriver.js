import './BaseDriver'
import { MissingPackageError } from 'grind-framework'
import { Str } from 'grind-support'

let redis = null
let uuid = null

/**
 * Loads the redis/uuid packages or throws an error
 * if they haven’t been added
 */
function loadPackage() {
	try {
		redis = require('redis')
	} catch(err) {
		throw new MissingPackageError('redis')
	}

	try {
		uuid = require('uuid/v4')
	} catch(err) {
		throw new MissingPackageError('uuid')
	}
}

/**
 * Redis/Bee backed Queue Driver
 */
export class RedisDriver extends BaseDriver {

	client = null
	clients = [ ]
	destroyed = false

	constructor(app, { connection, namespace, ...options } = { }) {
		super(app, options)

		loadPackage()

		if(typeof namespace !== 'string') {
			const info = require(this.app.paths.package)

			if(info.name.isNil) {
				namespace = 'grind'
			} else {
				namespace = Str.slug(info.name)
			}
		}

		if(connection.isNil) {
			connection = app.config.get('redis.default', null)
		}

		if(typeof connection === 'string') {
			connection = app.config.get(`redis.connections.${connection}`)
		}

		if(connection.isNil) {
			throw new Error('Invalid redis connection for queue')
		}


		let { host, port, password } = connection

		if(typeof host !== 'string') {
			host = 'localhost'
		}

		if(typeof host !== 'number') {
			port = 6379
		}

		if(typeof password !== 'string') {
			password = void 0
		}

		this.client = redis.createClient({
			host,
			port,
			password,
			options
		})

		this.namespace = namespace
	}

	connect() {
		return Promise.resolve()
	}

	dispatch(job) {
		return this._add(this.buildPayload(job))
	}

	listen(queues, concurrency, jobHandler, errorHandler) {
		const listeners = [ ]

		for(let i = 0; i < concurrency; i++) {
			listeners.push(this._listen(queues, jobHandler, errorHandler))
		}

		return Promise.all(listeners)
	}

	async _listen(queues, jobHandler, errorHandler) {
		const client = this.client.duplicate()
		this.clients.push(client)

		while(!this.destroyed) {
			await new Promise((resolve, reject) => {
				client.blpop(...queues.map(queue => `${this.namespace}:${queue}`), 0, (err, result) => {
					if(!err.isNil) {
						if(this.destroyed) {
							return resolve()
						}

						return reject(err)
					}

					client.get(result[1], async (err, message) => {
						if(!err.isNil) {
							if(this.destroyed) {
								return resolve()
							}

							return reject(err)
						}

						try {
							await this._receiveMessage(jobHandler, errorHandler, JSON.parse(message))
							resolve()
						} catch(err) {
							reject(err)
						}
					})
				})
			})
		}
	}

	async _receiveMessage(jobHandler, errorHandler, payload) {
		try {
			await jobHandler(payload)
		} catch(err) {
			try {
				await this._retryMessageOrRethrow(payload, err)
			} catch(err2) {
				this.client.del(payload.id, () => { })
				await errorHandler(payload, err)
			}
		}
	}

	async _retryMessageOrRethrow(payload, err) {
		const tries = Number(payload.tries) || 1

		if(tries <= 1) {
			throw err
		}

		const tryCount = Number(payload.try) || 1

		if(tryCount >= tries) {
			throw err
		}

		const timeout = Number(payload.timeout) || 0

		if(timeout > 0) {
			const at = Number(payload.at) || 0

			if(at > 0 && (Date.now() + timeout) > at) {
				throw err
			}
		}

		payload.try = tryCount + 1

		return this._add(payload)
	}

	_add(payload) {
		const queue = `${this.namespace}:${payload.queue}`

		if(typeof payload.id !== 'string') {
			payload.id = `${queue}:${uuid()}`
		}

		return new Promise((resolve, reject) => {
			this.client.set(payload.id, JSON.stringify(payload), 'PX', payload.timeout || 86400000 * 180, err => {
				if(!err.isNil) {
					return reject(err)
				}

				this.client.lpush(queue, payload.id, err => {
					if(!err.isNil) {
						return reject(err)
					}

					return resolve(true)
				})
			})
		})
	}

	destroy() {
		this.destroyed = true

		for(const client of [ this.client, ...this.clients ]) {
			client.end(true)
		}

		return Promise.resolve()
	}

}