'use strict';
const icons={
  home:'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  tube:'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm5 4v8l6-4z',
  cloud:'M7 19a5 5 0 0 1-1-9 6 6 0 0 1 11-2 4 4 0 0 1 1 8z',
  play:'M6 8h12l3 9a2 2 0 0 1-3 2l-3-2H9l-3 2a2 2 0 0 1-3-2zM8 11v4m-2-2h4m7 0h.01',
  proxy:'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
  admin:'M12 3a3 3 0 0 1 3 3v1h2a2 2 0 0 1 2 2v10H5V9a2 2 0 0 1 2-2h2V6a3 3 0 0 1 3-3zm-1 4h2V6a1 1 0 0 0-2 0z',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-5 2 2 2-1 2 2-1 2 2 2 2 2-2 2 1 2-2 2-2-1-2 2-2-2-2 1-2-2 1-2-2-2-2-2 2-2-1-2 2-2 2 1z'
};
const pages=[['home','ホーム','/index.html'],['tube','Cat Tube','/cattube.html'],['cloud','Cloud Cat','/cloudcat.html'],['play','Play Cat','/playcat.html'],['proxy','Proxy','/proxy.html'],['admin','Admin','/admin.html'],['settings','設定','/settings.html']];
const current=document.body.dataset.page||'home';
const shell=document.querySelector('[data-shell]');
if(shell){const nav=pages.map(([id,label,url])=>`<a class="${current===id?'active':''}" href="${url}"><span class="nav-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[id]}"/></svg></span>${label}</a>`).join('');shell.insertAdjacentHTML('afterbegin',`<aside class="sidebar" id="sidebar"><a class="brand" href="/index.html"><span class="brand-mark">C</span><span>Cat Hub<small>ONE PLACE. ALL CATS.</small></span></a><nav class="nav">${nav}</nav><div class="sidebar-foot"><div class="user"><span class="avatar">C</span><div><b data-user-name>ユーザー</b><small>オンライン</small></div></div></div></aside>`);}
document.querySelectorAll('[data-menu]').forEach(button=>button.addEventListener('click',()=>document.querySelector('#sidebar')?.classList.toggle('open')));
function toast(message){document.querySelector('.toast')?.remove();const node=document.createElement('div');node.className='toast';node.textContent=message;document.body.append(node);setTimeout(()=>node.remove(),2600);}
