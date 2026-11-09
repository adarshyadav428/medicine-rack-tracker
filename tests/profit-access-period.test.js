"use strict";
const assert = require("node:assert/strict");
const { canAccessProfit } = require("../lib/profit-access");
const { profitPeriod } = require("../lib/profit-period");
function check(label, test) { test(); console.log("PASS " + label); }
delete process.env.PROFIT_OWNER_EMAIL;
const owner = "adarshyadavazm123@gmail.com";
check("only the primary admin owns profit access", () => {
  assert.equal(canAccessProfit({ email: owner.toUpperCase(), role: "admin" }), true);
  for (const user of [null, {email:owner,role:"employee"}, {email:"other@example.test",role:"admin"}]) assert.equal(canAccessProfit(user), false);
});
check("owner override grants only one configured admin", () => {
  process.env.PROFIT_OWNER_EMAIL = " replacement@example.test ";
  assert.equal(canAccessProfit({email:owner,role:"admin"}), false);
  assert.equal(canAccessProfit({email:"replacement@example.test",role:"admin"}), true);
  delete process.env.PROFIT_OWNER_EMAIL;
});
check("custom interval includes both complete IST calendar days", () => {
  assert.deepEqual(profitPeriod({period:"custom",from:"2026-11-01",to:"2026-11-09"}), {
    period:"custom",from:"2026-10-31T18:30:00.000Z",to:"2026-11-09T18:30:00.000Z"
  });
});
check("leap days and year transitions preserve the exclusive upper bound", () => {
  assert.equal(profitPeriod({from:"2024-02-29",to:"2024-02-29"}).to,"2024-02-29T18:30:00.000Z");
  assert.equal(profitPeriod({from:"2026-12-31",to:"2026-12-31"}).to,"2026-12-31T18:30:00.000Z");
});
check("presets use the date in India even before UTC midnight", () => {
  const now = new Date("2026-12-31T20:00:00Z");
  for (const [period,from,to] of [
    ["today","2026-12-31T18:30:00.000Z","2027-01-01T18:30:00.000Z"],
    ["week","2026-12-25T18:30:00.000Z","2027-01-01T18:30:00.000Z"],
    ["month","2026-12-31T18:30:00.000Z","2027-01-31T18:30:00.000Z"],
    ["year","2026-12-31T18:30:00.000Z","2027-12-31T18:30:00.000Z"]
  ]) assert.deepEqual(profitPeriod({period},now),{period,from,to});
  assert.deepEqual(profitPeriod({period:"all"}),{period:"all",from:null,to:null});
});
check("malformed, impossible, missing and reversed dates fail explicitly", () => {
  for (const query of [
    {from:"2026-02-29",to:"2026-03-01"}, {from:"2026-04-31",to:"2026-05-01"},
    {from:"2026-1-01",to:"2026-01-01"}, {from:"2026-11-10",to:"2026-11-09"},
    {period:"custom"}, {from:"2026-11-09"}, {period:"month",from:"2026-11-01",to:"2026-11-09"},
    {period:"invalid"}, {period:"custom",from:["2026-11-09"],to:"2026-11-09"}
  ]) assert.throws(() => profitPeriod(query));
});

// Exercise the real auth response: navigation capability comes from the server,
// never a role/email supplied in a request body or localStorage.
const Module = require("module"), originalLoad = Module._load;
const real = require("../lib/supabase-server");
let email = owner, role = "admin", active = true;
const fake = {
  ...real,
  getServerConfig: () => ({enabled:true}),
  getSessionUser: async () => ({user:{id:"owner-id",email}}),
  getRoleInfo: async () => ({role,isActive:active}),
};
Module._load = function (name) { return /supabase-server$/.test(name) ? fake : originalLoad.apply(this,arguments); };
const auth = require("../api/auth");
Module._load = originalLoad;
async function me() {
  let result;
  await auth({url:"/api/auth/me",method:"GET",headers:{},body:{canViewProfit:true,email:owner}}, {
    statusCode:200,setHeader(){},getHeader(){},end(text){result={status:this.statusCode,json:JSON.parse(text)};}
  });
  return result;
}
(async () => {
  assert.equal((await me()).json.user.canViewProfit,true);
  email="other-admin@example.test";
  assert.equal((await me()).json.user.canViewProfit,false);
  email=owner;role="employee";
  assert.equal((await me()).json.user.canViewProfit,false);
  active=false;
  assert.equal((await me()).status,403);
  console.log("PASS auth exposes owner capability only for the active owner admin");
})().catch(error => {console.error(error);process.exitCode=1;});
