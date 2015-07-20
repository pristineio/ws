'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var ErrorCodes = require('./ErrorCodes');
var bufferUtil = require('./BufferUtil').BufferUtil;
var PerMessageDeflate = require('./PerMessageDeflate');

function Sender(socket, extensions) {
  this._socket = socket;
  this.extensions = extensions || {};
  this.firstFragment = true;
  this.compress = false;
  this.messageHandlers = [];
  this.processing = false;
}

util.inherits(Sender, EventEmitter);

Sender.prototype.close = function(code, data, mask, cb) {
  if(typeof code !== 'undefined') {
    if(typeof code !== 'number' ||
      !(code in ErrorCodes)) {
      throw new Error('first argument must be a valid error code number');
    }
  }
  code = code || 1000;
  var dataBuffer = new Buffer(2 + (data ? Buffer.byteLength(data) : 0));
  writeUInt16BE.call(dataBuffer, code, 0);
  if(dataBuffer.length > 2) {
    dataBuffer.write(data, 2);
  }

  var self = this;
  this.messageHandlers.push(function(callback) {
    self.frameAndSend(0x8, dataBuffer, true, mask);
    callback();
    if(typeof cb === 'function') {
      cb();
    }
  });
  this.flush();
};

Sender.prototype.ping = function(data, options) {
  var mask = options && options.mask;
  var self = this;
  this.messageHandlers.push(function(cb) {
    self.frameAndSend(0x9, data || '', true, mask);
    cb();
  });
  this.flush();
};

Sender.prototype.pong = function(data, options) {
  var mask = options && options.mask;
  var self = this;
  this.messageHandlers.push(function(cb) {
    self.frameAndSend(0xa, data || '', true, mask);
    cb();
  });
  this.flush();
};

Sender.prototype.send = function(data, options, cb) {
  var finalFragment = options && options.fin === false ? false : true;
  var mask = options && options.mask;
  var compress = options && options.compress;
  var opcode = options && options.binary ? 2 : 1;
  if(this.firstFragment) {
    this.firstFragment = false;
    this.compress = compress;
  } else {
    opcode = 0;
    compress = false;
  }
  if(finalFragment) {
    this.firstFragment = true;
  }

  var compressFragment = this.compress;

  var self = this;
  this.messageHandlers.push(function(callback) {
    self.applyExtensions(data, finalFragment, compressFragment,
      function(err, data) {
        if(err) {
          if(typeof cb === 'function') {
            cb(err);
          } else {
            this.emit('error', err);
          }
          return;
        }
        self.frameAndSend(opcode, data, finalFragment, mask, compress, cb);
        callback();
      }
    );
  });
  this.flush();
};

Sender.prototype.frameAndSend = function(opcode, data, f, m, c, cb) {
  var finalFragment = f;
  var maskData = m;
  var compressed = c;
  var canModifyData = false;

  if(!data) {
    try {
      this._socket.write(
        new Buffer([
            opcode | (finalFragment ? 0x80 : 0),
            0 | (maskData ? 0x80 : 0)
          ].concat(maskData ? [0, 0, 0, 0] : [])
        ),
        'binary',
        cb
      );
    } catch (e) {
      if(typeof cb === 'function') {
        cb(e);
      } else {
        this.emit('error', e);
      }
    }
    return;
  }

  if(!Buffer.isBuffer(data)) {
    canModifyData = true;
    if(data && (data.byteLength || data.buffer)) {
      data = getArrayBuffer(data);
    } else {
      data = new Buffer(data);
    }
  }

  var dataLength = data.length;
  var dataOffset = maskData ? 6 : 2;
  var secondByte = dataLength;

  if(dataLength >= 65536) {
    dataOffset += 8;
    secondByte = 127;
  } else if(dataLength > 125) {
    dataOffset += 2;
    secondByte = 126;
  }

  var mergeBuffers = dataLength < 32768 || (maskData && !canModifyData);
  var totalLength = mergeBuffers ? dataLength + dataOffset : dataOffset;
  var outputBuffer = new Buffer(totalLength);
  outputBuffer[0] = finalFragment ? opcode | 0x80 : opcode;
  if(compressed) {
    outputBuffer[0] |= 0x40;
  }

  switch(secondByte) {
    case 126:
      writeUInt16BE.call(outputBuffer, dataLength, 2);
      break;
    case 127:
      writeUInt32BE.call(outputBuffer, 0, 2);
      writeUInt32BE.call(outputBuffer, dataLength, 6);
  }

  try {
    if(maskData) {
      outputBuffer[1] = secondByte | 0x80;
      var mask = this._randomMask || (this._randomMask = getRandomMask());
      outputBuffer[dataOffset - 4] = mask[0];
      outputBuffer[dataOffset - 3] = mask[1];
      outputBuffer[dataOffset - 2] = mask[2];
      outputBuffer[dataOffset - 1] = mask[3];
      if(mergeBuffers) {
        bufferUtil.mask(data, mask, outputBuffer, dataOffset, dataLength);
        return this._socket.write(outputBuffer, 'binary', cb);
      }
      bufferUtil.mask(data, mask, data, 0, dataLength);
      this._socket.write(outputBuffer, 'binary');
      return this._socket.write(data, 'binary', cb);
    }
    outputBuffer[1] = secondByte;
    if(mergeBuffers) {
      data.copy(outputBuffer, dataOffset);
      return this._socket.write(outputBuffer, 'binary', cb);
    }
    this._socket.write(outputBuffer, 'binary');
    this._socket.write(data, 'binary', cb);
  } catch(ex) {
    if(typeof cb === 'function') {
      cb(ex);
    } else {
      this.emit('error', ex);
    }
  }
};


Sender.prototype.flush = function() {
  if(this.processing) {
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

Sender.prototype.applyExtensions = function(data, fin, compress, cb) {
  if(compress && data) {
    if((data.buffer || data) instanceof ArrayBuffer) {
      data = getArrayBuffer(data);
    }
    return this.extensions[PerMessageDeflate.extensionName]
      .compress(data, fin, cb);
  }
  cb(null, data);
};

function writeUInt16BE(value, offset) {
  this[offset] = (value & 0xff00)>>8;
  this[offset+1] = value & 0xff;
}

function writeUInt32BE(value, offset) {
  this[offset] = (value & 0xff000000)>>24;
  this[offset+1] = (value & 0xff0000)>>16;
  this[offset+2] = (value & 0xff00)>>8;
  this[offset+3] = value & 0xff;
}

function getArrayBuffer(data) {
  var array = new Uint8Array(data.buffer || data);
  var l = data.byteLength || data.length;
  var o = data.byteOffset || 0;
  var buffer = new Buffer(l);
  for(var i=0; i<l; ++i) {
    buffer[i] = array[o+i];
  }
  return buffer;
}

function getRandomMask() {
  return new Buffer([
    ~~(Math.random() * 255),
    ~~(Math.random() * 255),
    ~~(Math.random() * 255),
    ~~(Math.random() * 255)
  ]);
}

module.exports = Sender;
