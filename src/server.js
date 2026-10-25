process.env.TZ = process.env.TZ || 'Asia/Karachi';
const app = require('./app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`HCM Lite running on http://localhost:${port}`));
