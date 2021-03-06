import { serial as test } from 'ava'

import './helpers/TestJob'
import './helpers/Listener'
import './helpers/Service'

import '../src/Drivers/RedisDriver'

const service = new Service(test, 'redis', {
	image: 'redis:5.0.5-alpine',
	port: 6379
})

test.beforeEach(t => {
	t.context.driver = new RedisDriver({
		paths: {
			package: require.resolve('../package.json')
		}
	}, {
		connection: {
			host: 'localhost',
			port: service.port
		}
	})

	return t.context.driver.connect()
})

test.afterEach.always(t => t.context.driver.destroy())

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

test('resiliency', async t => {
	let count = 0

	await t.context.driver.dispatch(new TestJob({ id: 1 }))

	for(const client of [ t.context.driver.client, ...t.context.driver.clients ]) {
		client.stream.destroy()
	}

	await t.context.driver.dispatch(new TestJob({ id: 1 }))

	return Listener(t.context.driver, () => ++count < 2).then(() => t.is(count, 2))
})
