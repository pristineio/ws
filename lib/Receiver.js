'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

var util = require('util');
var Handler = require('./Handler');
var BufferPool = require('./BufferPool');
var bufferUtil = require('./BufferUtil').BufferUtil;
var PerMessageDeflate = require('./PerMessageDeflate');

function Receiver(extensions) {
  var fragmentedPoolPrevUsed = -1;
  this.fragmentedBufferPool = new BufferPool(
    1024,
    function(db, length) {
      return db.used + length;
    },
    function(db) {
      return fragmentedPoolPrevUsed >= 0 ?
        (fragmentedPoolPrevUsed + db.used) / 2 :
        db.used;
    }
  );

  // memory pool for unfragmented messages
  var unfragmentedPoolPrevUsed = -1;
  this.unfragmentedBufferPool = new BufferPool(
    1024,
    function(db, length) {
      return db.used + length;
    },
    function(db) {
      return unfragmentedPoolPrevUsed >= 0 ?
        (unfragmentedPoolPrevUsed + db.used) / 2 :
        db.used;
    }
  );

  this.extensions = extensions || {};
  this.state = {
    activeFragmentedOperation: null,
    lastFragment: false,
    masked: false,
    opcode: 0,
    fragmentedOperation: false
  };
  this.overflow = [];
  this.headerBuffer = new Buffer(10);
  this.expectOffset = 0;
  this.expectBuffer = null;
  this.expectHandler = null;
  this.currentMessage = [];
  this.messageHandlers = [];
  this.expect('header', 2, this.processPacket);
  this.dead = false;
  this.processing = false;

  this.onerror = function() {};
  this.ontext = function() {};
  this.onbinary = function() {};
  this.onclose = function() {};
  this.onping = function() {};
  this.onpong = function() {};
}


Receiver.prototype.add = function(data) {
  var dataLength = data.length;
  if(!dataLength) {
    return;
  }
  if(!this.expectBuffer) {
    return this.overflow.push(data);
  }
  var toRead = Math.min(
    dataLength,
    this.expectBuffer.length - this.expectOffset
  );

  data.copy(this.expectBuffer, this.expectOffset, 0, toRead);

  this.expectOffset += toRead;
  if(toRead < dataLength) {
    this.overflow.push(data.slice(toRead));
  }
  while(this.expectBuffer && this.expectOffset == this.expectBuffer.length) {
    var bufferForHandler = this.expectBuffer;
    this.expectBuffer = null;
    this.expectOffset = 0;
    this.expectHandler(bufferForHandler);
  }
};

Receiver.prototype.cleanup = function() {
  this.dead = true;
  this.overflow = null;
  this.headerBuffer = null;
  this.expectBuffer = null;
  this.expectHandler = null;
  this.unfragmentedBufferPool = null;
  this.fragmentedBufferPool = null;
  this.state = null;
  this.currentMessage = null;
  this.onerror = null;
  this.ontext = null;
  this.onbinary = null;
  this.onclose = null;
  this.onping = null;
  this.onpong = null;
};

Receiver.prototype.expect = function(type, length, handler) {
  if(length === 0) {
    return handler(null);
  }
  this.expectBuffer = type === 'header' ?
    this.headerBuffer.slice(this.expectOffset, this.expectOffset + length) :
    this.allocateFromPool(length, this.state.fragmentedOperation);
  this.expectHandler = handler;
  var toRead = length;
  while (toRead > 0 && this.overflow.length > 0) {
    var fromOverflow = this.overflow.pop();
    if(toRead < fromOverflow.length) {
      this.overflow.push(fromOverflow.slice(toRead));
    }
    var read = Math.min(fromOverflow.length, toRead);
    fromOverflow.copy(this.expectBuffer, this.expectOffset, 0, read);
    this.expectOffset += read;
    toRead -= read;
  }
};

Receiver.prototype.allocateFromPool = function(length, isFragmented) {
  return (isFragmented ?
    this.fragmentedBufferPool :
    this.unfragmentedBufferPool
  ).get(length);
};

Receiver.prototype.processPacket = function (data) {
  if(this.extensions[PerMessageDeflate.extensionName]) {
    if((data[0] & 0x30) !== 0) {
      return this.error('reserved fields (2, 3) must be empty', 1002);
    }
  } else {
    if((data[0] & 0x70) !== 0) {
      return this.error('reserved fields must be empty', 1002);
    }
  }
  this.state.lastFragment = (data[0] & 0x80) == 0x80;
  this.state.masked = (data[1] & 0x80) == 0x80;
  var compressed = (data[0] & 0x40) == 0x40;
  var opcode = data[0] & 0xf;
  if(opcode === 0) {
    if(compressed) {
      return this.error(
        'continuation frame cannot have the Per-message Compressed bits', 1002
      );
    }
    // continuation frame
    this.state.fragmentedOperation = true;
    this.state.opcode = this.state.activeFragmentedOperation;
    if(!(this.state.opcode == 1 || this.state.opcode == 2)) {
      return this.error(
        'continuation frame cannot follow current opcode', 1002
      );
    }
  } else {
    if(opcode < 3 && !!this.state.activeFragmentedOperation) {
      return this.error(
        'data frames after the initial data frame must have opcode 0', 1002
      );
    }
    if(opcode >= 8 && compressed) {
      return this.error(
        'control frames cannot have the Per-message Compressed bits', 1002
      );
    }
    this.state.compressed = compressed;
    this.state.opcode = opcode;
    if(this.state.lastFragment === false) {
      this.state.fragmentedOperation = true;
      this.state.activeFragmentedOperation = opcode;
    } else {
      this.state.fragmentedOperation = false;
    }
  }
  this.myHandler = new Handler(this);
  if(!(this.state.opcode in this.myHandler.opcodes)) {
    return this.error('no handler for opcode ' + this.state.opcode, 1002);
  }
  this.myHandler.start(data);
};

Receiver.prototype.endPacket = function() {
  if(!this.state.fragmentedOperation) {
    this.unfragmentedBufferPool.reset(true);
  } else if(this.state.lastFragment) {
    this.fragmentedBufferPool.reset(false);
  }
  this.expectOffset = 0;
  this.expectBuffer = null;
  this.expectHandler = null;
  if(this.state.lastFragment &&
    this.state.opcode === this.state.activeFragmentedOperation) {
    this.state.activeFragmentedOperation = null;
  }
  this.state.lastFragment = false;
  this.state.opcode = !this.state.activeFragmentedOperation ?
    0 :
    this.state.activeFragmentedOperation;
  this.state.masked = false;
  this.expect('header', 2, this.processPacket);
};

Receiver.prototype.reset = function() {
  if(this.dead) {
    return;
  }
  this.state = {
    activeFragmentedOperation: null,
    lastFragment: false,
    masked: false,
    opcode: 0,
    fragmentedOperation: false
  };
  this.fragmentedBufferPool.reset(true);
  this.unfragmentedBufferPool.reset(true);
  this.expectOffset = 0;
  this.expectBuffer = null;
  this.expectHandler = null;
  this.overflow = [];
  this.currentMessage = [];
  this.messageHandlers = [];
};

Receiver.prototype.unmask = function (mask, buf, binary) {
  if(mask && buf) {
    bufferUtil.unmask(buf, mask);
  }
  if(binary) {
    return buf;
  }
  return !buf ? '' : buf.toString('utf8');
};

Receiver.prototype.concatBuffers = function(buffers) {
  var length = 0;
  for(var i=0, l=buffers.length; i<l; ++i) {
    length += buffers[i].length;
  }
  var mergedBuffer = new Buffer(length);
  bufferUtil.merge(mergedBuffer, buffers);
  return mergedBuffer;
};

Receiver.prototype.error = function (reason, protocolErrorCode) {
  this.reset();
  this.onerror(reason, protocolErrorCode);
  return this;
};

Receiver.prototype.flush = function() {
  if(this.processing || this.dead) {
    return;
  }
  var handler = this.messageHandlers.shift();
  if(!handler) {
    return;
  }
  this.processing = true;
  var self = this;
  handler(function() {
    self.processing = false;
    self.flush();
  });
};

Receiver.prototype.applyExtensions = function(messageBuffer, fin, c, cb) {
  var compressed = c;
  var self = this;
  if(!compressed) {
    return cb(null, messageBuffer);
  }
  this.extensions[PerMessageDeflate.extensionName]
    .decompress(messageBuffer, fin, function(err, buffer) {
      if(self.dead) {
        return;
      }
      if(err) {
        return cb(new Error('invalid compressed data'));
      }
      cb(null, buffer);
    }
  );
};

module.exports = Receiver;
