'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

function BufferPool(initialSize, growStrategy, shrinkStrategy) {
  if(!initialSize) {
    initialSize = 0;
  }
  this.growStrategy = (growStrategy || function(db, size) {
    return db.used + size;
  }).bind(null, this);

  this.shrinkStrategy = (shrinkStrategy || function(db) {
    return initialSize;
  }).bind(null, this);

  this.buffer = initialSize ? new Buffer(initialSize) : null;
  this.offset = 0;
  this.used = 0;
  this.changeFactor = 0;
}

Object.defineProperty(BufferPool.prototype, 'size', {
  get: function get() {
    return !this.buffer ? 0 : this.buffer.length;
  }
});

BufferPool.prototype.get = function(length) {
  if(this.buffer == null || this.offset + length > this.buffer.length) {
    var newBuf = new Buffer(this.growStrategy(length));
    this.buffer = newBuf;
    this.offset = 0;
  }
  this.used += length;
  var buf = this.buffer.slice(this.offset, this.offset + length);
  this.offset += length;
  return buf;
};

BufferPool.prototype.reset = function(forceNewBuffer) {
  var len = this.shrinkStrategy();
  if(len < this.size) {
    this.changeFactor -= 1;
  }
  if(forceNewBuffer || this.changeFactor < -2) {
    this.changeFactor = 0;
    this.buffer = len ? new Buffer(len) : null;
  }
  this.offset = 0;
  this.used = 0;
};

module.exports = BufferPool;
