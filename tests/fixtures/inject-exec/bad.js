const { exec } = require('child_process');

function ping(host) {
  return exec('ping -c 1 ' + host);
}

function runScript(cmd) {
  return execSync(`sh -c ${cmd}`);
}

function evalInput(expr) {
  return eval('({ result: ' + expr + ' })');
}

function compileFn(body) {
  return new Function('x', 'return x * ' + body);
}
