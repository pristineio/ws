'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

var util = require('util');

exports.parse = function(value) {
  value = value || '';
  var extensions = {};
  value.split(',').forEach(function(v) {
    var params = v.split(';');
    var token = params.shift().trim();
    var paramsList = extensions[token] = extensions[token] || [];
    var parsedParams = {};
    params.forEach(function(param) {
      var parts = param.trim().split('=');
      var key = parts[0];
      var value = parts[1];
      if(!value) {
        value = true;
      } else {
        value = value.replace(/"/ig, '');
      }
      (parsedParams[key] = parsedParams[key] || []).push(value);
    });
    paramsList.push(parsedParams);
  });
  return extensions;
};

exports.format = function(value) {
  return Object.keys(value).map(function(token) {
    var paramsList = value[token];
    if(!util.isArray(paramsList)) {
      paramsList = [paramsList];
    }
    return paramsList.map(function(params) {
      return [token].concat(Object.keys(params).map(function(k) {
        var p = params[k];
        if(!util.isArray(p)) {
          p = [p];
        }
        return p.map(function(v) {
          return v === true ? k : k + '=' + v;
        }).join('; ');
      })).join('; ');
    }).join(', ');
  }).join(', ');
};
