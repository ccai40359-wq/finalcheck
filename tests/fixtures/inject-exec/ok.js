const { execFile, spawn } = require('child_process');

function ping(host) {
  return execFile('ping', ['-c', '1', host]);
}

function listDir(dir) {
  return spawn('ls', [dir]);
}

function constantFold() {
  return eval('2 + 2'); // 常量表达式，无变量插值
}
