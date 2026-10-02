'use strict';
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const port = 3217;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: require('path').join(__dirname, '..'),
  env: { ...process.env, PORT:String(port), COUNTDOWN_MS:'180', GAME_MS:'3500' },
  stdio: ['ignore','pipe','pipe'],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const onceAck = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));
const fail = msg => { throw new Error(msg); };

(async () => {
  try {
    await sleep(700);
    const health = await fetch(`${base}/health`).then(r => r.json());
    if (!health.ok) fail('Health endpoint failed');

    const a = io(base, { transports:['websocket'], forceNew:true });
    const b = io(base, { transports:['websocket'], forceNew:true });
    await Promise.all([
      new Promise((res,rej)=>{a.on('connect',res);a.on('connect_error',rej)}),
      new Promise((res,rej)=>{b.on('connect',res);b.on('connect_error',rej)}),
    ]);

    const created = await onceAck(a, 'createRoom', { name:'Alpha', playerToken:'player_alpha_123456' });
    if (!created.ok || !created.room?.code) fail('Room creation failed');
    const joined = await onceAck(b, 'joinRoom', { code:created.room.code, name:'Beta', playerToken:'player_beta_1234567' });
    if (!joined.ok || joined.room.players.length !== 2) fail('Second device join failed');

    const started = await onceAck(a, 'startGame', {});
    if (!started.ok) fail(`Game start failed: ${started.error}`);
    await sleep(450);

    let latest;
    const statePromise = new Promise(resolve => {
      const handler = state => {
        if (state.state === 'playing') { latest = state; a.off('state', handler); resolve(state); }
      };
      a.on('state', handler);
    });
    const playing = await Promise.race([statePromise, sleep(900).then(()=>null)]);
    if (!playing) fail('Round did not transition to playing');

    const before = playing.players.find(p => p.id === created.playerId)?.x;
    a.emit('input', { right:true, up:false, down:false, left:false });
    await sleep(420);
    a.emit('input', { right:false, up:false, down:false, left:false });
    await sleep(120);
    const moved = await new Promise(resolve => {
      const handler = state => { a.off('state', handler); resolve(state); };
      a.on('state', handler);
      setTimeout(()=>{a.off('state',handler);resolve(latest)},500);
    });
    const after = moved.players.find(p => p.id === created.playerId)?.x;
    if (!(after > before)) fail(`Server-authoritative movement failed (${before} -> ${after})`);

    const pulse = await onceAck(a, 'pulse', {});
    if (!pulse.ok) fail('Pulse action failed');

    const qrStatus = await fetch(`${base}/api/qr?text=${encodeURIComponent(base+'/?room='+created.room.code)}`);
    if (!qrStatus.ok || !String(qrStatus.headers.get('content-type')).includes('image/png')) fail('QR endpoint failed');

    a.disconnect(); b.disconnect();
    console.log('✓ health endpoint');
    console.log('✓ two independent clients joined the same room');
    console.log('✓ host started a synchronized round');
    console.log('✓ server-authoritative movement changed live state');
    console.log('✓ pulse ability acknowledged');
    console.log('✓ QR invite endpoint returned PNG');
    console.log('SMOKE TEST PASSED');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})();
