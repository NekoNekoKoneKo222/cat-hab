'use strict';

const { EventEmitter } = require('events');

// ルートモジュールとSocket.IOセットアップ(server.js)を疎結合にするための
// プロセス内イベントバス。DB更新後にここへemitし、server.js側でSocket.IOへ配信する。
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
