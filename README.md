# wsd: yet another node.js websocket library

[![Build Status](https://travis-ci.org/websockets/ws.svg?branch=master)](https://travis-ci.org/websockets/ws)

`wsd` is a simplified fork of `ws`.

## Protocol support

* **HyBi drafts 07-12** (Use the option `protocolVersion: 8`)
* **HyBi drafts 13-17** (Current default, alternatively option `protocolVersion: 13`)

### Installing

```
npm install --save wsd
```

### Sending and receiving text data

```js
var WebSocket = require('ws');
var ws = new WebSocket('ws://www.host.com/path');
ws.on('open', function open() {
  ws.send('something');
});

ws.on('message', function(data, flags) {
  // flags.binary will be set if a binary data is received.
  // flags.masked will be set if the data was masked.
});
```

### Sending binary data

```js
var WebSocket = require('ws');
var ws = new WebSocket('ws://www.host.com/path');

ws.on('open', function open() {
  var array = new Float32Array(5);

  for (var i = 0; i < array.length; ++i) {
    array[i] = i / 2;
  }

  ws.send(array, { binary: true, mask: true });
});
```

Setting `mask`, as done for the send options above, will cause the data to be
masked according to the WebSocket protocol. The same option applies for text
data.

### Server example

```js
var WebSocketServer = require('ws').Server;
var wss = new WebSocketServer({ port: 8080 });
wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(message) {
    console.log('received: %s', message);
  });
  ws.send('something');
});
```

### Server sending broadcast data

```js
var WebSocketServer = require('ws').Server;
var wss = new WebSocketServer({ port: 8080 });
wss.broadcast = function broadcast(data) {
  wss.clients.forEach(function each(client) {
    client.send(data);
  });
};
```

### Error handling best practices

```js
// If the WebSocket is closed before the following send is attempted
ws.send('something');

// Errors (both immediate and async write errors) can be detected in an optional
// callback. The callback is also the only way of being notified that data has
// actually been sent.
ws.send('something', function ack(error) {
  // if error is not defined, the send has been completed,
  // otherwise the error object will indicate what failed.
});

// Immediate errors can also be handled with try/catch-blocks, but **note** that
// since sends are inherently asynchronous, socket write failures will *not* be
// captured when this technique is used.
try { ws.send('something'); }
catch (e) { /* handle error */ }
```

### Running the tests

```
make test
```

## API Docs

See [`/doc/wsd.md`](https://github.com/websockets/ws/blob/master/doc/ws.md) for Node.js-like docs for the ws classes.

## Changelog

We're using the GitHub [`releases`](https://github.com/websockets/ws/releases) for changelog entries.

## License

(The MIT License)

Copyright (c) 2011 Einar Otto Stangvik &lt;einaros@gmail.com&gt;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
