const $=id=>document.getElementById(id);let picks=[];let currentMode="multi";

function setStatus(t){$("status").textContent=t}
function render(rows){
  $("rows").innerHTML=rows.length?rows.map((p,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc((p.home||'?')+' vs '+(p.away||'?'))+'</td><td>'+esc(p.marketLabel||p.marketFamily||'?')+'</td><td>'+esc(p.selection||'?')+'</td><td>'+Number(p.odds||0).toFixed(2)+'</td><td>'+((Number(p.probability)||0)*100).toFixed(1)+'%</td><td>'+esc(p.source||'?')+'</td></tr>').join(''):'<tr><td colspan="7">No selections met the threshold.</td></tr>';
  $("book").disabled=!rows.length;
}
async function run(url,label){
  setStatus("Loading…");$("run").disabled=true;$("over15").disabled=true;$("book").disabled=true;$("result").textContent="";
  $("rows").innerHTML='<tr><td colspan="7">Fetching today’s fixtures and markets…</td></tr>';
  try{
    const r=await fetch(url);const d=await r.json();if(!r.ok)throw new Error(d.error||"Analysis failed");
    picks=d.predictions||[];currentMode=label;
    $("summary").textContent='Selected '+picks.length+' of '+(d.requested||picks.length)+' requested • '+(d.todayEvents??"?")+' today events • '+(d.failedEvents||0)+' market fetch failures';
    render(picks);setStatus("Done");
  }catch(e){setStatus("Error");$("rows").innerHTML='<tr><td colspan="7" class="err">'+esc(e.message)+'</td></tr>'}
  finally{$("run").disabled=false;$("over15").disabled=false;$("book").disabled=!picks.length}
}
$("run").onclick=()=>{const family=encodeURIComponent($("market").value);const min=encodeURIComponent($("min").value);const limit=encodeURIComponent($("limit").value);run('/api/multi-market?family='+family+'&minProbability='+min+'&limit='+limit,"multi")};
$("over15").onclick=()=>{const min=encodeURIComponent($("min").value);const limit=encodeURIComponent(Math.min(Number($("limit").value)||25,25));run('/api/over15?minProbability='+min+'&limit='+limit,"over15")};

async function book(){
  $("book").disabled=true;setStatus("Creating…");$("result").textContent="";
  const endpoint=currentMode==="over15"?"/api/over15/booking":"/api/booking";
  const body=currentMode==="over15"?{predictions:picks}:{selections:picks.map(p=>({eventId:p.eventId,marketId:p.marketId,specifier:p.specifier||"",outcomeId:p.outcomeId}))};
  try{
    const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();
    if(d.bookingCode){$("result").textContent="Booking code: "+d.bookingCode+(d.shareURL?"\n"+d.shareURL:"");setStatus("Booking ready");return}
    if(d.fallbackAvailable&&d.fallback){
      const lines=(d.fallback.selections||[]).map((s,i)=>(i+1)+'. '+(s.home||'?')+' vs '+(s.away||'?')+' — '+(s.selection||'Selection')+' @ '+(s.odds||'?')).join('\n');
      $("result").innerHTML='<strong>Direct booking API unavailable.</strong><br>'+esc(d.error||"SportyBet rejected the share request.")+'<br><br><a class="fallback-link" href="'+esc(d.fallback.url)+'" target="_blank" rel="noopener">Open SportyBet</a><br><br><pre>'+esc(lines)+'</pre><small>Use the listed selections in the SportyBet betslip and its Book Bet/share control. Omegaplus does not place or stake bets.</small>';
      setStatus("Website fallback ready");return
    }
    throw new Error(d.error||"Booking code failed");
  }catch(e){$("result").textContent=e.message;setStatus("Error")}finally{$("book").disabled=!picks.length}
}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
