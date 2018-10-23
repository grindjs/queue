import './Job'
import './Queue'

import './Drivers/BaseDriver'
import './Drivers/BeanstalkDriver'
import './Drivers/FaktoryDriver'
import './Drivers/RabbitDriver'
import './Drivers/SQSDriver'

export class QueueFactory {
	app = null
	connections = { }
	jobs = { }
	drivers = {
		beanstalk: BeanstalkDriver,
		beanstalkd: BeanstalkDriver,
		faktory: FaktoryDriver,
		rabbit: RabbitDriver,
		rabbitmq: RabbitDriver,
		amqp: RabbitDriver,
		sqs: SQSDriver
	}

	constructor(app) {
		this.app = app
	}

	async dispatch(job, connection = null) {
		connection = await this.get(connection)
		return connection.dispatch(job)
	}

	async status(job, connection = null) {
		connection = await this.get(connection)
		return connection.status(job)
	}

	async get(connection) {
		let name = null

		if(connection.isNil) {
			connection = this.app.config.get('queue.default')
		}

		if(typeof connection === 'string') {
			const q = this.connections[connection]

			if(!q.isNil) {
				return q
			}

			name = connection
			connection = this.app.config.get(`queue.connections.${name}`)
		}

		if(connection.isNil || typeof connection !== 'object') {
			throw new Error('Invalid config')
		}

		const config = { ...connection }
		const driverClass = this.drivers[config.driver]

		if(driverClass.isNil) {
			throw new Error(`Unsupported queue driver: ${config.driver}`)
		}

		connection = await this.make(driverClass, config)

		if(!name.isNil) {
			this.connections[name] = connection
		}

		return connection
	}

	async make(driverClass, config) {
		const driver = new driverClass(this.app, config)
		await driver.ready()

		return new Queue(this.app, this, driver)
	}

	registerDriver(name, driverClass) {
		if(!(driverClass.prototype instanceof BaseDriver)) {
			throw new Error('All queue driver classes must inherit from BaseDriver')
		}

		this.drivers[name] = driverClass
	}

	register(jobClass) {
		if(!(jobClass.prototype instanceof Job)) {
			throw new Error('All job classes must inherit from Job')
		} else if(jobClass.jobName.isNil) {
			throw new Error('Invalid Job, must have jobName set.')
		}

		this.jobs[jobClass.jobName] = jobClass
	}

	destroy() {
		return Promise.all(Object.values(this.connections).map(connection => connection.destroy()))
	}

}
