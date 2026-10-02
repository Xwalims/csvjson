#!/usr/bin/env node
'use strict';

// bin/csvjson.js is a thin shim: all logic lives in ../src/cli.js.
process.exitCode = require('../src/cli.js').main(process.argv.slice(2));