export default {
  /** @type {import('@kb-labs/sdk').WebSocketHandler} */
  async execute(_context, input) {
    if (await input.sender.getConnectionId() !== input.connection.connectionId) {
      throw new Error('Sender connection reference does not match the handler input.');
    }
    if (input.event === 'send') {
      await input.sender.send({ type: 'ready', timestamp: 1 });
      return;
    }

    if (input.event === 'send-after-close') {
      await input.sender.close(4000, 'fixture closed');
      await input.sender.send({ type: 'late', timestamp: 4 });
      return;
    }

    await input.sender.send({ type: 'ready', timestamp: 1 });
    await input.sender.broadcast({ type: 'broadcast', timestamp: 2 });
    await input.sender.broadcast({ type: 'broadcast-self', timestamp: 3 }, false);
    await input.sender.sendTo(['target-a', 'target-b'], { type: 'targeted', timestamp: 4 });
    await input.sender.send({ type: 'ordered', payload: 1, timestamp: 5 });
    await input.sender.send({ type: 'ordered', payload: 2, timestamp: 6 });
    await input.sender.close(4001, 'fixture complete');
  },
};
