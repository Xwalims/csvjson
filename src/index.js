'use strict';

/**
 * csvjson — public API.
 *
 *   const csvjson = require('csvjson');
 *   const table = csvjson.parseCsv(text);
 *   const json  = csvjson.toJson(table);
 *
 * Everything is re-exported from the individual modules so callers can reach
 * for the low-level tokenizer when they need to.
 */

const tokenizeModule = require('./tokenize.js');
const parseModule = require('./parse.js');
const inferModule = require('./infer.js');
const stringifyModule = require('./stringify.js');
const cliModule = require('./cli.js');

module.exports = {
  // defaults & errors
  DEFAULTS: tokenizeModule.DEFAULTS,
  DELIMITER_CANDIDATES: tokenizeModule.DELIMITER_CANDIDATES,
  QUOTE_CANDIDATES: tokenizeModule.QUOTE_CANDIDATES,
  EXIT_DATA_ERROR: tokenizeModule.EXIT_DATA_ERROR,
  CsvError: tokenizeModule.CsvError,
  UnterminatedQuoteError: tokenizeModule.UnterminatedQuoteError,
  RaggedRowError: tokenizeModule.RaggedRowError,

  // tokenizer
  Tokenizer: tokenizeModule.Tokenizer,
  tokenize: tokenizeModule.tokenize,

  // parsing
  RAGGED_MODES: parseModule.RAGGED_MODES,
  detectDelimiter: parseModule.detectDelimiter,
  detectQuote: parseModule.detectQuote,
  applyRagged: parseModule.applyRagged,
  parseCsv: parseModule.parseCsv,

  // inference
  TYPES: inferModule.TYPES,
  classifyCell: inferModule.classifyCell,
  coerce: inferModule.coerce,
  inferColumn: inferModule.inferColumn,
  inferRows: inferModule.inferRows,

  // writing
  SHAPES: stringifyModule.SHAPES,
  needsQuoting: stringifyModule.needsQuoting,
  stringifyField: stringifyModule.stringifyField,
  stringifyRow: stringifyModule.stringifyRow,
  stringify: stringifyModule.stringify,
  transposeTable: stringifyModule.transposeTable,
  columnsToRows: stringifyModule.columnsToRows,
  toJson: stringifyModule.toJson,
  fromJson: stringifyModule.fromJson,

  // cli
  main: cliModule.main,
  parseArgs: cliModule.parseArgs,
  USAGE: cliModule.USAGE,
};