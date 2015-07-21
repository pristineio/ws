'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

try {
  module.exports = require('utf-8-validate');
} catch (e) {
  module.exports = {
    isValidUTF8: function(buffer) {
      return true;
    }
  };
}
