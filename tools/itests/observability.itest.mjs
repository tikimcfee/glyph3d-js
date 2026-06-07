// observability — the error.* / log.* / metric.* verbs are wired through the command bus
// and return well-formed shapes. The self-instrument path (handler throws → ErrorTracker →
// error.list) is exercised by the runner's backstop on every test; here we assert the verb
// surface itself is live (the bus-native query side of the observability story).

const READ = `(async()=>{const ex=(c)=>window.__glyphClient.router.execute(c);const el=await ex("error.list");const es=await ex("error.stats");const ml=await ex("metric.list");const lt=await ex("log.tail 10");const ll=await ex("log.level info");return{errList:Array.isArray(el&&el.data&&el.data.errors),errStats:typeof (es&&es.data&&es.data.total)==="number",metricsOk:Array.isArray(ml&&ml.data&&ml.data.metrics),logOk:Array.isArray(lt&&lt.data&&lt.data.entries),logLevelOk:/OK/.test((ll&&ll.text)||"")};})()`;

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');
  const r = await app.evalPage(READ);
  assert.ok(r.errList, 'error.list returns a data.errors array');
  assert.ok(r.errStats, 'error.stats returns a numeric total');
  assert.ok(r.metricsOk, 'metric.list returns a data.metrics array');
  assert.ok(r.logOk, 'log.tail returns a data.entries array');
  assert.ok(r.logLevelOk, 'log.level sets verbosity (OK)');
  assert.noErrors(app);
};
