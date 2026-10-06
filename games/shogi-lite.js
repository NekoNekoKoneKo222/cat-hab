'use strict';
const boardNode=document.querySelector('#board'),turnNode=document.querySelector('#turn');
const initial=[['bR','bG','bK','bG','bR'],['bP','bP','bP','bP','bP'],[null,null,null,null,null],["wP","wP","wP","wP","wP"],["wR","wG","wK","wG","wR"]];
let board,side,selected,winner;
function reset(){board=initial.map(row=>row.slice());side='w';selected=null;winner=null;draw();}
const inside=(r,c)=>r>=0&&r<5&&c>=0&&c<5;
function moves(r,c){const piece=board[r][c];if(!piece)return[];const owner=piece[0],type=piece[1],dir=owner==='w'?-1:1,result=[];
 const steps=type==='K'?[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]:type==='G'?[[dir,-1],[dir,0],[dir,1],[0,-1],[0,1],[-dir,0]]:type==='P'?[[dir,0]]:[];
 for(const [dr,dc] of steps){const nr=r+dr,nc=c+dc;if(inside(nr,nc)&&board[nr][nc]?.[0]!==owner)result.push([nr,nc]);}
 if(type==='R')for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){let nr=r+dr,nc=c+dc;while(inside(nr,nc)){if(board[nr][nc]?.[0]===owner)break;result.push([nr,nc]);if(board[nr][nc])break;nr+=dr;nc+=dc;}}
 return result;}
function draw(){boardNode.replaceChildren();turnNode.textContent=winner?(winner==='w'?'先手':'後手')+'の勝ちです。':(side==='w'?'先手':'後手')+'の番です。';const legal=selected?moves(...selected):[];
 for(let r=0;r<5;r++)for(let c=0;c<5;c++){const square=document.createElement('button');square.type='button';square.className='square'+((r+c)%2?' dark':'')+(selected?.[0]===r&&selected?.[1]===c?' selected':'')+(legal.some(([a,b])=>a===r&&b===c)?' legal':'');square.setAttribute('role','gridcell');square.setAttribute('aria-label',`${r+1}行${c+1}列 ${board[r][c]||'空'}`);square.dataset.side=board[r][c]?.[0]||'';square.textContent=board[r][c]?({'K':'王','G':'金','P':'歩','R':'飛'})[board[r][c][1]]:' ';square.addEventListener('click',()=>choose(r,c));boardNode.append(square);}}
function choose(r,c){if(winner)return;const piece=board[r][c];if(selected&&moves(...selected).some(([a,b])=>a===r&&b===c)){const moving=board[selected[0]][selected[1]],captured=board[r][c];board[r][c]=moving;board[selected[0]][selected[1]]=null;selected=null;if(captured?.[1]==='K')winner=side;else side=side==='w'?'b':'w';draw();return;}selected=piece?.[0]===side?[r,c]:null;draw();}
document.querySelector('#reset').addEventListener('click',reset);reset();
