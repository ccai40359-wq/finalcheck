// password reset tokens for legacy accounts
function makeResetToken(name) {
  return md5(name + Date.now());
}
