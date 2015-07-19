var benchmark = require('benchmark');
var Sender = require('../').Sender;
var suite = new benchmark.Suite('Sender');
require('tinycolor');
require('./util');

suite.on('start', function() {
});

//suite.on('cycle', function() {
//});

var A = [];
for(var k=0; k<(1<<16); ++k) {
  A.push(Math.random());
}

suite.add('iterate with cached length', function() {
  for(var i=0, l=A.length; i<l; ++i) {
    (function(){})();
  }
});

suite.add('iterate without cached length', function() {
  for(var i=0; i<A.length; ++i) {
    (function(){})();
  }
});

suite.add('iterate with forEach', function() {
  A.forEach(function() {
    (function(){})();
  });
});

suite.add('iterate with forEach cached', function() {
  var f = function() {
    (function(){})();
  };
  A.forEach(f);
});

suite.add('iterate with while, uncached', function() {
  var i = 0;
  while(i < A.length) {
    (function(){})();
    ++i;
  }
});

suite.add('iterate with while, cached', function() {
  var i = 0;
  var l = A.length;
  while(i < l) {
    (function(){})();
    ++i;
  }
});

suite.on('cycle', function(bench, details) {
  console.log('\n  ' + suite.name.grey, details.name.white.bold);
  console.log('  ' + [details.hz.toFixed(2).cyan + ' ops/sec'.grey,
    details.count.toString().white + ' times executed'.grey,
    'benchmark took '.grey + details.times.elapsed.toString().white + 
      ' sec.'.grey
  ].join(', '.grey));  
});

if (!module.parent) {
  suite.run();
} else {
  module.exports = suite;
}

