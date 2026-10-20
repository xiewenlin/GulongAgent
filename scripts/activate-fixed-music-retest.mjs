// Deployment-only, idempotent activation of the ONE reviewed fixed regression.
// Does not claim a challenge, run models, reset counters, or extend old windows.
import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";
import { activateFixedMusicRetestForDeployment } from "../server/capability-fixed-music-retest.js";

let client;
try {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=="--commit"||!/^[a-f0-9]{40}$/.test(args[1]))throw Object.assign(new Error(),{code:"INVALID_COMMIT_ARGUMENT"});
  const installedCommit=(await readFile(new URL("../.deploy-commit",import.meta.url),"utf8")).trim();
  if(installedCommit!==args[1])throw Object.assign(new Error(),{code:"FIXED_RETEST_DEPLOYMENT_MISMATCH"});
  client=new MongoClient(process.env.MONGODB_URI,{maxPoolSize:1,retryWrites:false,serverSelectionTimeoutMS:5000});
  await client.connect();const db=client.db(process.env.MONGODB_DB||"gulong_platform");
  const result=await activateFixedMusicRetestForDeployment({getCollection:async name=>db.collection(name),
    expectedCommit:args[1],installedCommit});
  console.log(JSON.stringify({ok:true,...result}));
}catch(error){console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.code||"")?error.code:"FIXED_RETEST_ACTIVATION_FAILED"}));process.exitCode=1;}
finally{if(client)await client.close();}
