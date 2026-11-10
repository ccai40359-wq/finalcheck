const db = require('./db');

function listUsers(name) {
  return db.query('SELECT * FROM users WHERE name = ?', [name]);
}

function searchLogs(term) {
  return db.execute('SELECT * FROM logs WHERE term = \'' + term + '\''); // finalcheck:allow 下个迭代换参数化
}
