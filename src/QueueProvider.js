import './QueueFactory'

import './Commands/MakeJobCommand'
import './Commands/QueueWorkCommand'

export async function QueueProvider(app, classes = { }) {
	const factoryClass = classes.factoryClass || QueueFactory
	app.queue = new factoryClass(app)

	for(const connectionName of Object.keys(app.config.get('queue.connections'))) {
		// Trigger initial setup of backend engines
		await app.queue.get(connectionName)
	}

	if(app.cli.isNil) {
		return
	}

	app.cli.register([
		classes.makeJobCommandClass || MakeJobCommand,
		classes.queueWorkCommandClass || QueueWorkCommand
	])
}

QueueProvider.shutdown = app => app.queue.destroy()
QueueProvider.priority = 60000
