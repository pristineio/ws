'use strict';
var ErrorCodes = require('./ErrorCodes');
var Validation = require('./Validation').Validation;

function Handler(receiver) {
  this.receiver = receiver;
  this.opcodes = {1: true, 2: true, 8: true, 9: true, 10: true};
}

function readUInt16BE(start) {
  return (this[start]<<8) + this[start+1];
}

function readUInt32BE(start) {
  return (this[start]<<24) + (this[start+1]<<16) + (this[start+2]<<8) +
    this[start+3];
}

function clone(obj) {
  var cloned = {};
  for(var k in obj) {
    if(obj.hasOwnProperty(k)) {
      cloned[k] = obj[k];
    }
  }
  return cloned;
}

Handler.prototype.start = function(data) {
  var self = this;
  var firstLength = data[1] & 0x7f;
  if(!self.receiver.state.lastFragment && self.receiver.state.opcode >= 8) {
    return self.receiver.error('fragmented ' + self.receiver.state.opcode +
      ' is not supported', 1002);
  }
  if(firstLength >= 126 && self.receiver.state.opcode >= 8) {
    return self.receiver.error('control frames cannot have more than 125 ' +
      'bytes of data', 1002);
  }
  if(firstLength < 126) {
    self.getData.call(self, firstLength);
  } else if(firstLength === 126) {
    self.receiver.expect('header', 2, function(data) {
      self.getData(readUInt16BE.call(data, 0));
    });
  } else if(firstLength === 127) {
    self.receiver.expect('header', 8, function(data) {
      if(readUInt32BE.call(data, 0) != 0) {
        return self.receiver.error('packets with length spanning more than ' +
          '32 bit is currently not supported', 1008);
      }
      self.getData(readUInt32BE.call(data, 4));
    });
  }
};

Handler.prototype.getData = function(length) {
  var self = this;
  if(self.receiver.state.masked) {
    self.receiver.expect('header', 4, function(data) {
      var mask = data;
      self.receiver.expect('data', length, function(data) {
        self.finish(mask, data);
      });
    });
  } else {
    self.receiver.expect('data', length, function(data) {
      self.finish(null, data);
    });
  }
};

Handler.prototype.finish = function(mask, data) {
  var self = this;
  var packet = self.receiver.unmask(mask, data, true) || new Buffer(0);
  var state = clone(self.receiver.state);
  self.receiver.messageHandlers.push(function(callback) {
    switch(state.opcode) {
      case 1:
      case 2:
        self.receiver.applyExtensions(
          packet,
          state.lastFragment,
          state.compressed,
          function(err, buffer) {
            if(err) {
              return self.receiver.error(err.message, 1007);
            }
            if(buffer) {
              self.receiver.currentMessage.push(buffer);
            }
            if(state.lastFragment) {
              var messageBuffer = self.receiver.concatBuffers(
                self.receiver.currentMessage
              );
              self.receiver.currentMessage = [];
              switch(state.opcode) {
                case 1:
                  if(!Validation.isValidUTF8(messageBuffer)) {
                    return self.receiver.error('invalid utf8 sequence', 1007);
                  }
                  self.receiver.ontext(messageBuffer.toString('utf8'), {
                    masked: state.masked,
                    buffer: messageBuffer
                  });
                  break;
                case 2:
                  self.receiver.onbinary(messageBuffer, {
                    masked: state.masked,
                    buffer: messageBuffer
                  });
                  break;
              }
            }
            callback();
          }
        );
        break;
      case 8:
        if(packet && packet.length === 1) {
          return self.receiver.error('close packets with data must be at ' +
            'least two bytes long', 1002);
        }
        var code = packet && packet.length > 1 ?
          readUInt16BE.call(packet, 0) :
          1000;
        if(!(code in ErrorCodes)) {
          return self.receiver.error('invalid error code', 1002);
        }
        var message = '';
        if(packet && packet.length > 2) {
          var messageBuffer = packet.slice(2);
          if(!Validation.isValidUTF8(messageBuffer)) {
            return self.receiver.error('invalid utf8 sequence', 1007);
          }
          message = messageBuffer.toString('utf8');
        }
        self.receiver.onclose(code, message, {masked: state.masked});
        self.receiver.reset();
        break;
      case 9:
        self.receiver.onping(data, {masked: state.masked, binary: true});
        callback();
        break;
      case 10:
        self.receiver.onpong(data, {masked: state.masked, binary: true});
        callback();
        break;
    }
  });
  self.receiver.flush();
  if(state.opcode !== 8) {
    self.receiver.endPacket();
  }
};

module.exports = Handler;
