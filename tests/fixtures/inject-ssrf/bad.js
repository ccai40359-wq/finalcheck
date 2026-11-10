const axios = require('axios');

async function probe(req) {
  const a = await fetch(req.body.url);
  const b = await axios.get(req.query.target);
  const c = await axios(req.params.host);
  return [a, b, c];
}
