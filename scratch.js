const axios = require('axios');
axios.get('https://api.yeet.su/qobuz/track/85311025?quality=6')
  .then(r => console.log(JSON.stringify(r.data, null, 2).substring(0, 500)))
  .catch(e => console.log('Err:', e.message));
