import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

function localApi():Plugin {
  return { name:'batch-lab-api', configureServer(server) {
    server.middlewares.use('/api/lab',async(req,res,next)=>{
      try { const {default:handler}=await import('./server/api');await handler(req,res); }
      catch(error){next(error);}
    });
  }};
}
export default defineConfig(({mode})=>{
  const env=loadEnv(mode,process.cwd(),'');
  for(const [name,value]of Object.entries(env)) {
    if(/^(DATABASE_URL|POSTGRES_URL|BATCH_LAB_|VITE_BATCH_LAB_MODEL_KEY)/.test(name) && !process.env[name])process.env[name]=value;
  }
  return {plugins:[react(),localApi()]};
});
