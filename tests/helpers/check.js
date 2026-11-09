"use strict";
const assert=require("assert/strict");
function check(label,actual,expected){assert.deepEqual(actual,expected,label);console.log("PASS "+label);}
module.exports={check};
