const message=document.querySelector('[data-auth-message]');
const say=s=>{if(message)message.textContent=s};
async function api(url,method='GET',body){const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;}
const login=document.querySelector('[data-login-form]');
login?.addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/auth/login','POST',{username:login.username.value.trim(),password:login.password.value});location.assign('/index.html')}catch(err){say(err.message)}});
const register=document.querySelector('[data-register-form]');
register?.addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/auth/register','POST',{username:register.username.value.trim(),displayName:register.displayName.value.trim(),password:register.password.value,acceptTerms:register.acceptTerms.checked});location.assign('/index.html')}catch(err){say(err.message)}});
if(document.body.dataset.auth==='required'){
 try{const {user}=await api('/api/auth/me');if(!user){location.replace('/login.html')}else{document.querySelectorAll('[data-user-name]').forEach(n=>n.textContent=user.displayName);document.querySelectorAll('.sidebar-foot .user b').forEach(n=>n.textContent=user.displayName);if(document.body.dataset.admin==='required'){if(!user.isAdmin)throw Error('管理者権限がありません');const status=await api('/api/admin/status');document.dispatchEvent(new CustomEvent('catHubAdminReady',{detail:status}));}}}catch(err){say(err.message)}
}
document.querySelectorAll('[data-logout]').forEach(n=>n.addEventListener('click',async e=>{e.preventDefault();await api('/api/auth/logout','POST');location.assign('/login.html')}));
