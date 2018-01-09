import { serial as test } from 'ava'

import './helpers/TestJob'
import './helpers/Listener'
import './helpers/Service'

import '../src/Drivers/SQSDriver'

const service = new Service(test, 'sqs', {
	image: 'vsouza/sqs-local',
	port: 9324
})
const queueName = 'test'

test.beforeEach(async t => {
	t.context.driver = new SQSDriver(null, {
		endpoint: `http://localhost:${service.port}`,
		access_key: 'fake-id',
		secret_key: 'fake-secret',
		queues: {
			[queueName]: { }
		}
	})

	await t.context.driver.ready()
	return t.context.driver.connect()
})

test.afterEach.always(async t => {
	const queueUrl = t.context.driver.client.queueUrls[queueName]
	t.context.driver.destroy()

	// Delete the queue so it will be recreated
	// This prevents the current Listener's residual long-polling from getting the next test's messages
	await new Promise((resolve, reject) => {
		return t.context.driver.client.client.deleteQueue({ QueueUrl: queueUrl }, err => {
			if(err) {
				return reject(err)
			}

			return resolve()
		})
	})
})

test('dispatch', async t => {
	const payload = { time: Date.now() }
	const job = new TestJob({ ...payload })

	await t.context.driver.dispatch(job)

	return Listener(t.context.driver, job => t.deepEqual(job.data.data, payload))
})

test('retry dispatch', async t => {
	const payload = { time: Date.now() }
	const job = new TestJob({ ...payload })
	let tries = 0

	await t.context.driver.dispatch(job.$tries(2))

	return Listener(t.context.driver, job => {
		t.is(job.tries, 2)
		t.deepEqual(job.data.data, payload)

		if(++tries === 1 || tries > 2) {
			throw new Error
		}
	})
})

test('multi dispatch', t => {
	let count = 0

	setTimeout(() => t.context.driver.dispatch(new TestJob({ id: 1 })), 50)
	setTimeout(() => t.context.driver.dispatch(new TestJob({ id: 2 })), 100)
	setTimeout(() => t.context.driver.dispatch(new TestJob({ id: 3 })), 200)
	setTimeout(() => t.context.driver.dispatch(new TestJob({ id: 4 })), 400)

	return Listener(t.context.driver, () => ++count < 4).then(() => t.is(count, 4))
})

test('delayed dispatch', async t => {
	const payload = { time: Date.now() }
	const job = new TestJob({ ...payload })

	const dispatchedAt = Date.now()
	await t.context.driver.dispatch(job.$delay(1000))

	return Listener(t.context.driver, job => {
		t.is(Date.now() - dispatchedAt >= 1000, true)
		t.deepEqual(job.data.data, payload)
	})
})
