const db = require('./db');

function listUsers(name) {
  return db.query('SELECT * FROM users WHERE name = \'' + name + '\'');
}

function updateUser(id, email) {
  return db.query(`UPDATE users SET email = '${email}' WHERE id = ${id}`);
}
