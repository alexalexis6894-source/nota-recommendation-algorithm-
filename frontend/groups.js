/* НОТА Air: реальные группы и пробники. Названия и метки только через текстовые узлы. */
(function () {
  'use strict';
  var api = window.NotaCollection;
  if (!api) return;
  var $ = function (id) { return document.getElementById(id); };
  var groups = [], samples = [], kit = {mode:'preview',bonus:{available:0,pending:0,percent:15}}, active = null, response = null, requestId = 0, editId = null, mode = 'close';
  // Подборы обоих режимов по группе: запрос или готовый ответ, чтобы переключение было мгновенным.
  var cache = {};
  // Два режима подбора: ближе к своим ароматам или тот же характер с новыми нотами.
  var MODES = [['close','Похожие на мои','Те же главные ноты, что в вашей группе.'],['new','Новое в моём вкусе','Тот же характер, но другие ноты: чего у вас ещё нет.']];
  var selected = new Set(), previewId = 0, previewTimer, returnFocus, noticeTimer;
  // Экран группы: 12 плиток, «Показать ещё 12» до 36. Подбор приходит одним запросом на 36,
  // поэтому «ещё» раскрывается мгновенно и не запускает на хостинге второй процесс Python.
  var PAGE = 12, MAX_SHOWN = 36, shown = PAGE, expanded = false, tracked = {};
  function track(name, params) { if (window.notaTrack) window.notaTrack(name, params || {}); }
  function node(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'text') n.textContent = v;
      else if (k === 'click') n.addEventListener('click', v);
      else if (k === 'checked' || k === 'disabled') n[k] = v;
      else n.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function button(text, fn, cls) { return node('button', { type: 'button', class: cls || 'btn quiet', text: text, click: fn }); }
  function message(text) {
    $('ng-notice').textContent = text; $('ng-notice').hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(function () { $('ng-notice').hidden = true; }, 4000);
  }
  function errorText(e) { return e && e.status === 422 ? 'Проверьте состав. В группе до 30 ароматов, в наборе до 15.' : 'Не удалось связаться с сервисом. Попробуйте ещё раз.'; }
  function open(d) { returnFocus = document.activeElement; d.showModal(); }
  document.querySelectorAll('[data-ng-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  ['group-editor','sample-preview','sheet-more','group-menu','share-sheet','rec-sheet','rank-sheet'].forEach(function (id) {
    $(id).addEventListener('close', function () { if (returnFocus && returnFocus.isConnected) returnFocus.focus(); });
  });
  // Шторка приоритета закрывается от любого касания вне неё, и от нажатия, и от свайпа.
  $('rank-sheet').addEventListener('pointerdown', function (e) {
    var d=e.currentTarget; if(e.target!==d) return;
    var r=d.getBoundingClientRect();
    if(e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom) d.close();
  });
  $('more-btn').addEventListener('click', function () { open($('sheet-more')); });
  function navigate() {
    var name = location.hash.slice(2);
    if (['collection','taste','picks'].indexOf(name) < 0) name = 'collection';
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll('[data-tab]').forEach(function (v) {
      var on = v.dataset.tab === name; v.classList.toggle('is-active', on);
      if (on) v.setAttribute('aria-current','page'); else v.removeAttribute('aria-current');
    });
    document.querySelectorAll('dialog[open]:not(#sheet-photo)').forEach(function (d) { d.close(); });
    window.scrollTo(0,0);
    renderKitBar();
  }
  window.addEventListener('hashchange', navigate);
  function tone(key) {
    var hash = 0; key = String(key || ''); for (var i=0;i<key.length;i++) hash = ((hash*31)+key.charCodeAt(i))>>>0;
    return hash%6;
  }
  function chip(t) { return node('span',{class:'ng-tag tone-'+tone(t.key),'data-accord':t.key,text:t.label}); }
  // Полоса аккордов вместо фото флакона: сегмент шире у более сильного аккорда, цвет как у метки.
  function strip(accords) {
    var weights=[5,4,3,2,1];
    return node('span',{class:'ng-strip','aria-hidden':'true'},(accords || []).slice(0,5).map(function (a,i) {
      var seg=node('i',{class:'tone-'+tone(a)}); seg.style.flex=String(weights[i]); return seg;
    }));
  }
  function plural(n,one,few,many) { return n%10===1 && n%100!==11 ? one : n%10>=2 && n%10<=4 && !(n%100>=12 && n%100<=14) ? few : many; }
  function tags(ts) { return node('div',{class:'ng-tags'},(ts || []).map(chip)); }
  function perfume(item) {
    var brand=String(item.brand || '').replace(/-/g,' ');
    var name=String(item.name || '').replace(/\s*for (women and men|men and women|women|men)\s*$/i,'');
    if (name.toLowerCase().endsWith(' '+brand.toLowerCase())) name=name.slice(0,-brand.length).trim();
    return node('div',{class:'ng-perfume'},[node('strong',{text:name}),node('span',{class:'muted',text:brand})]);
  }
  function rub(n) { return Number(n).toLocaleString('ru-RU')+' ₽'; }
  // Объём и цена отливанта: клиент всегда видит, сколько миллилитров получит.
  function offerText(it) { return it.offer ? it.offer.volume+' · '+rub(it.offer.price) : 'Нет в наличии'; }
  function cleanName(item) {
    var brand=String(item.brand || '').replace(/-/g,' ');
    var name=String(item.name || '').replace(/\s*for (women and men|men and women|women|men)\s*$/i,'');
    if (name.toLowerCase().endsWith(' '+brand.toLowerCase())) name=name.slice(0,-brand.length).trim();
    return {name:name,brand:brand};
  }
  function ratingText(reputation, short) {
    if(!(reputation && Number.isFinite(reputation.rating) && reputation.rating_count>0)) return short ? '' : 'Нет данных об оценках';
    var value=reputation.rating.toLocaleString('ru-RU',short?{minimumFractionDigits:1,maximumFractionDigits:1}:{maximumFractionDigits:2});
    if(short) return '★ '+value;
    var count=reputation.rating_count;
    return '★ '+value+' / 5 · '+count.toLocaleString('ru-RU')+' '+plural(count,'оценка','оценки','оценок');
  }
  function updateEntry() {
    var n = api.items().length;
    $('create-from-collection').disabled = !n;
    $('group-intro').textContent = n ? 'Выберите свои духи. НОТА найдёт похожие для вашей группы.' : 'Добавьте любимые духи, чтобы найти похожие.';
  }
  window.addEventListener('nota-collection-changed', updateEntry);
  function renderGroups() {
    var list = $('groups-list'); list.textContent = '';
    if (!groups.length) list.appendChild(node('p',{class:'ng-empty',text:'Создайте первую группу из своих ароматов. Например, для вечера или лета.'}));
    groups.forEach(function (g) {
      var card = button('', function () { showGroup(g.id); }, 'ng-group');
      card.dataset.group = g.id;
      card.appendChild(node('h2',{text:g.name}));
      card.appendChild(lineup(g,5));
      card.appendChild(tags(g.tags));
      card.appendChild(node('span',{class:'ng-link',text:'Найти похожие →'})); list.appendChild(card);
    });
  }
  function loadGroups() {
    $('groups-list').textContent = 'Загружаем группы…';
    return api.request('GET','/v1/groups').then(function (d) { groups=d.groups; renderGroups(); }, function (e) {
      $('groups-list').textContent=errorText(e); $('groups-list').appendChild(button('Повторить',loadGroups));
    });
  }
  function editGroup(g) {
    var mine=api.items();
    if (!mine.length) {
      if (location.hash === '#/collection') $('rx-open').click();
      else {
        // Сначала завершается переход вкладки, затем открывается лист добавления.
        window.addEventListener('hashchange', function () { $('rx-open').click(); }, { once: true });
        location.hash='/collection';
      }
      return;
    }
    editId=g ? g.id : crypto.randomUUID(); selected=new Set(g ? g.pids : mine.slice(0,30).map(function (r) { return String(r.pid); }));
    $('group-editor-title').textContent=g ? 'Изменить группу' : 'Новая группа'; $('group-name').value=g ? g.name : ''; $('group-error').textContent='';
    $('group-name-options').textContent=''; $('group-members').textContent='';
    mine.forEach(function (it) {
      var input=node('input',{type:'checkbox',value:String(it.pid),checked:selected.has(String(it.pid))});
      input.addEventListener('change',function () {
        if (input.checked) selected.add(String(it.pid)); else selected.delete(String(it.pid));
        $('group-save').disabled=!selected.size;
        clearTimeout(previewTimer); previewTimer=setTimeout(previewNames,250);
      });
      $('group-members').appendChild(node('label',{class:'ng-member'},[input,perfume(it)]));
    });
    $('group-save').disabled=!selected.size; open($('group-editor')); previewNames();
  }
  function previewNames() {
    var seq=++previewId;
    if (!selected.size) { $('group-name-options').textContent='Выберите хотя бы один аромат.'; return; }
    $('group-name-options').textContent='Подбираем названия…';
    api.request('POST','/v1/groups/preview',{pids:Array.from(selected)}).then(function (d) {
      if (seq!==previewId) return;
      $('group-name-options').textContent=''; $('group-name').placeholder=d.suggested_names[0];
      d.suggested_names.forEach(function (name) { $('group-name-options').appendChild(button(name,function () { $('group-name').value=name; },'ng-name-option')); });
    }, function () { if(seq===previewId) $('group-name-options').textContent='Можно написать своё название.'; });
  }
  $('create-group').addEventListener('click',function () { editGroup(); });
  $('create-from-collection').addEventListener('click',function () { editGroup(); });
  $('group-form').addEventListener('submit',function (e) {
    e.preventDefault(); if (!selected.size || $('group-save').disabled) return;
    $('group-save').disabled=true; $('group-save').textContent='Сохраняем группу…'; $('group-error').textContent='';
    var isNew=!groups.some(function (x) { return x.id===editId; });
    api.request('PUT','/v1/groups/'+editId,{name:$('group-name').value,pids:Array.from(selected)}).then(function (g) {
      if(isNew) track('group_created',{size:g.pids.length});
      forget(g.id); groups=groups.filter(function (x) { return x.id!==g.id; }); groups.unshift(g); renderGroups();if(samples.length)loadSamples();
      $('group-editor').close(); location.hash='/taste'; showGroup(g.id);
    },function (e) { $('group-error').textContent=errorText(e); }).finally(function () { $('group-save').disabled=!selected.size; $('group-save').textContent='Найти похожие ароматы'; });
  });
  function fetchMode(id, m) {
    var key=id+':'+m;
    // Через 5 минут запрашиваем заново: коллекция могла измениться.
    if(cache[key] && Date.now()-cache[key].at>300000) delete cache[key];
    if(!cache[key]) {
      cache[key]={at:Date.now(),promise:api.request('GET','/v1/groups/'+id+'/recommendations?mode='+m+'&limit='+MAX_SHOWN).then(function (d) {
        cache[key].data=d; return d;
      },function (e) { delete cache[key]; throw e; })};
    }
    return cache[key];
  }
  function forget(id) { MODES.forEach(function (m) { delete cache[id+':'+m[0]]; }); }
  function showGroup(id, keepScroll) {
    var entry=fetchMode(id,mode);
    // Второй режим грузим сразу в фоне, пока человек читает первый.
    MODES.forEach(function (m) { if(m[0]!==mode) fetchMode(id,m[0]).promise.catch(function () {}); });
    if(active!==id) { shown=PAGE; expanded=false; }
    active=id; var seq=++requestId;
    $('groups-home').hidden=true; $('group-detail').hidden=false;
    if(entry.data) { response=entry.data; renderDetail(keepScroll); return; }
    if(keepScroll && response) { renderDetail(true, true); response=null; }
    else {
      response=null; $('group-detail').textContent='';
      $('group-detail').appendChild(button('← Все группы',backGroups,'text-btn'));
      $('group-detail').appendChild(node('p',{class:'ng-empty',text:'Сравниваем вашу группу с ароматами каталога…'}));
    }
    entry.promise.then(function (d) {
      if(seq!==requestId) return; response=d; renderDetail(keepScroll);
    },function (e) { if(seq!==requestId)return; $('group-detail').appendChild(node('p',{role:'alert',text:errorText(e)}));$('group-detail').appendChild(button('Повторить',function () { showGroup(id); })); });
  }
  function backGroups() { ++requestId; active=null;response=null; $('groups-home').hidden=false;$('group-detail').hidden=true; window.scrollTo(0,0); }
  function groupBar(g) {
    var bar=node('div',{class:'ng-bar'});
    bar.appendChild(node('button',{type:'button',class:'text-btn ng-back','aria-label':'Все группы',text:'←',click:backGroups}));
    bar.appendChild(node('h1',{class:'view-title ng-title',tabindex:'-1',text:g.name}));
    bar.appendChild(node('button',{type:'button',class:'ng-icon ng-share-btn','data-testid':'ng-share',text:'Поделиться',click:function () { openShare(g); }}));
    bar.appendChild(node('button',{type:'button',class:'ng-icon','aria-label':'Действия с группой','aria-haspopup':'dialog','data-testid':'ng-menu',text:'⋯',click:function () { openMenu(g); }}));
    return bar;
  }
  // Место аромата в группе: 1-3 медалью, дальше номером.
  function medal(i) {
    return node('span',{class:'ng-medal'+(i<3?' is-'+(i+1):''),'aria-hidden':'true',text:String(i+1)});
  }
  // Ароматы группы столбиком по местам. Свёрнуто видны первые limit, дальше строка «и ещё N».
  function lineup(g, limit) {
    var many=g.items.length>1, n=limit ? Math.min(limit,g.items.length) : g.items.length;
    var col=node('span',{class:'ng-lineup'});
    g.items.slice(0,n).forEach(function (it,i) {
      var names=cleanName(it);
      col.appendChild(node('span',{class:'ng-lineup-row'},[many?medal(i):null,
        node('span',{class:'ng-lineup-name',text:names.name}),names.brand?node('span',{class:'ng-lineup-brand',text:names.brand}):null]));
    });
    var rest=g.items.length-n;
    if(rest>0) col.appendChild(node('span',{class:'ng-lineup-rest',text:'и ещё '+rest+' '+plural(rest,'аромат','аромата','ароматов')}));
    return col;
  }
  // Шапка группы: раздел «Ароматы в группе» открывает шторку с порядком,
  // столбик под ним раскрывается на месте и показывает все ароматы, метки и правку состава.
  function groupBase(g) {
    var many=g.items.length>1;
    var wrap=node('section',{class:'ng-base'});
    wrap.appendChild(many
      ? node('button',{type:'button',class:'ng-base-head','aria-haspopup':'dialog','data-testid':'ng-order',click:function () { openRank(g); }},[
          node('span',{class:'ng-base-title',text:'Ароматы в группе'}),node('span',{class:'ng-order-hint',text:'⠿ Порядок'})])
      : node('h2',{class:'ng-base-head',text:'Аромат в группе'}));
    wrap.appendChild(node('button',{type:'button',class:'ng-lineup-toggle','aria-expanded':String(expanded),'data-testid':'ng-lineup',click:function () { expanded=!expanded; renderDetail(true); }},[
      lineup(g,expanded?0:3),node('span',{class:'ng-lineup-more',text:expanded?'Свернуть':'Подробнее'})]));
    if(expanded) {
      wrap.appendChild(tags(g.tags));
      wrap.appendChild(node('p',{class:'ng-caption',text:'Самые заметные ноты ваших ароматов по голосам Fragrantica. Цвет полосы на плитках показывает те же оттенки.'}));
      wrap.appendChild(button('Изменить состав и название',function () { editGroup(g); },'text-btn'));
    } else {
      wrap.appendChild(node('div',{class:'ng-notes'},(g.tags || []).slice(0,3).map(chip)));
    }
    return wrap;
  }
  // Шторка приоритета: подсказка серым и столбик, который тянут за ручку.
  function openRank(g) {
    var body=$('rank-body'); body.textContent='';
    body.appendChild(node('p',{class:'ng-rank-hint',text:'Поставьте духи по приоритету: сверху те, что нравятся больше всего, снизу меньше всего. На верхние НОТА опирается сильнее, когда подбирает похожие.'}));
    body.appendChild(rankList(g));
    if(!$('rank-sheet').open) open($('rank-sheet'));
  }
  // Список приоритета: строку тянут за ручку ⠿ пальцем или мышью, с клавиатуры стрелками.
  // Порядок меняется сразу на экране, на сервер уходит одним запросом после паузы.
  function rankList(g) {
    var list=node('ol',{class:'ng-rank','aria-label':'Приоритет ароматов'});
    function rows() { return Array.prototype.slice.call(list.children); }
    function renumber() {
      rows().forEach(function (row,i) {
        var m=row.querySelector('.ng-medal'); m.replaceWith(medal(i));
        row.querySelector('.ng-handle').setAttribute('aria-label','Переместить «'+row.dataset.name+'», '+(i+1)+' место из '+g.pids.length);
      });
    }
    function commit() {
      var pids=rows().map(function (row) { return row.dataset.rank; });
      if(pids.join()!==g.pids.join()) reorder(g,pids);
    }
    g.items.forEach(function (it,i) {
      var names=cleanName(it);
      var handle=node('button',{type:'button',class:'ng-handle','data-testid':'ng-handle',text:'⠿'});
      var row=node('li',{class:'ng-rank-row','data-rank':String(it.pid),'data-name':names.name},[medal(i),perfume(it),handle]);
      handle.addEventListener('keydown',function (e) {
        var to=e.key==='ArrowUp'?row.previousElementSibling:e.key==='ArrowDown'?row.nextElementSibling:null;
        if(!to) return;
        e.preventDefault();
        if(e.key==='ArrowUp') list.insertBefore(row,to); else list.insertBefore(to,row);
        renumber(); handle.focus(); commit();
      });
      handle.addEventListener('pointerdown',function (e) {
        if(e.button>0) return;
        e.preventDefault(); handle.setPointerCapture(e.pointerId);
        var startY=e.clientY, shift=0; row.classList.add('is-dragging');
        function move(ev) {
          var dy=ev.clientY-startY-shift, prev=row.previousElementSibling, next=row.nextElementSibling;
          // Строка меняется местами с соседней, когда палец прошёл половину её высоты.
          if(next && dy>next.offsetHeight/2) { list.insertBefore(next,row); shift+=next.offsetHeight+gap(); dy=ev.clientY-startY-shift; renumber(); }
          else if(prev && dy<-prev.offsetHeight/2) { list.insertBefore(row,prev); shift-=prev.offsetHeight+gap(); dy=ev.clientY-startY-shift; renumber(); }
          row.style.transform='translateY('+dy+'px)';
        }
        function gap() { return parseFloat(getComputedStyle(list).rowGap) || 0; }
        function end() {
          handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
          row.classList.remove('is-dragging'); row.style.transform=''; commit();
        }
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
      });
      list.appendChild(row);
    });
    renumber();
    return list;
  }
  var reorderTimer, reorderSeq=0;
  // Новый порядок сразу виден в столбике на экране группы; подборка пересчитывается после сохранения.
  function reorder(g,pids) {
    var byPid={};g.items.forEach(function (it) { byPid[String(it.pid)]=it; });
    var before={pids:g.pids,items:g.items};
    g.pids=pids;g.items=pids.map(function (p) { return byPid[p]; });
    var base=document.querySelector('#group-detail .ng-base');
    if(base) base.replaceWith(groupBase(g));
    clearTimeout(reorderTimer);
    var seq=++reorderSeq;
    reorderTimer=setTimeout(function () {
      track('group_ranked',{size:pids.length});
      api.request('PUT','/v1/groups/'+g.id,{name:g.name,pids:pids}).then(function (saved) {
        if(seq!==reorderSeq) return;
        forget(saved.id);
        groups=groups.map(function (x) { return x.id===saved.id ? saved : x; });renderGroups();
        if(active===saved.id) { response=Object.assign({},response,{group:saved}); showGroup(saved.id,true); }
        message('Порядок сохранён. Подборка учитывает ваш приоритет');
      },function (e) {
        if(seq!==reorderSeq) return;
        g.pids=before.pids;g.items=before.items;renderDetail(true);if($('rank-sheet').open) openRank(g);message(errorText(e));
      });
    },700);
  }
  function tile(it, d) {
    var inKit=samples.some(function (x) { return x.pid===it.pid; });
    var soldOut=d.stock_connected && !it.offer;
    var names=cleanName(it), meta=[ratingText(it.reputation,true)];
    if(d.stock_connected && it.offer) meta.push(it.offer.volume+' '+rub(it.offer.price));
    var open=node('button',{type:'button',class:'ng-tile-open','aria-label':'Подробнее: '+names.name+', '+names.brand,click:function () { openRec(it,d); }},[
      strip(it.accords),
      node('strong',{class:'ng-tile-name',text:names.name}),
      node('span',{class:'ng-tile-brand',text:names.brand}),
      node('span',{class:'ng-tile-meta','data-rating':it.pid,'data-offer':it.offer?it.pid:'',text:soldOut?'Нет в наличии':meta.filter(Boolean).join(' · ')})
    ]);
    var add=addButton(it,d,inKit,soldOut);
    return node('article',{class:'ng-tile'+(soldOut?' is-out':''),'data-recommendation':it.pid},[open,add]);
  }
  function addButton(it,d,inKit,soldOut) {
    var add=button(soldOut?'Нет в наличии':inKit?'В наборе ✓':'В набор',function () {
      add.disabled=true;add.textContent='Добавляем…';
      api.request('POST','/v1/samples',{pid:it.pid,group_id:d.group.id}).then(function () {
        if(!samples.some(function (x) { return x.pid===it.pid; }))samples.push(Object.assign({},it,{group_name:d.group.name}));
        track('kit_added',{mode:mode,count:samples.length});
        renderSamples();add.textContent='В наборе ✓';message('Аромат добавлен в набор пробников');
      },function (e) { add.disabled=false;add.textContent='В набор';message(e && e.detail || errorText(e)); });
    },'btn');
    add.disabled=inKit || soldOut;add.dataset.sampleAdd=it.pid;
    return add;
  }
  function renderDetail(keepScroll, pending) {
    if(!response)return;
    var y=window.scrollY;
    var d=response,root=$('group-detail');root.textContent='';
    root.appendChild(groupBar(d.group));
    root.appendChild(groupBase(d.group));
    root.appendChild(modeSwitch(d.group.id));
    var hint=mode==='new'?'тот же характер, другие ноты':'те же главные ноты';
    if(pending) {
      // Второй режим ещё в пути: шапка остаётся на месте, меняется только сетка.
      root.appendChild(node('p',{class:'ng-count',text:'Подбираем ароматы…'}));
      root.appendChild(node('div',{class:'ng-grid ng-loading','aria-hidden':'true'},[0,1,2,3].map(function () { return node('div',{class:'ng-tile ng-skeleton'}); })));
      if(keepScroll) window.scrollTo(0,y);
      return;
    }
    var total=d.items.length, visible=d.items.slice(0,Math.min(shown,MAX_SHOWN));
    root.appendChild(node('p',{class:'ng-count',id:'ng-count','aria-live':'polite',text:total?total+' '+plural(total,'аромат','аромата','ароматов')+' · '+hint:''}));
    if(!total)root.appendChild(node('p',{class:'ng-empty',text:mode==='new'?'Новых ароматов того же характера пока нет. Попробуйте режим «Похожие на мои».':'Близких совпадений пока нет. Попробуйте изменить состав группы.'}));
    var key=d.group.id+':'+mode;
    if(!tracked[key]) { tracked[key]=true; track('recs_opened',{mode:mode,count:total}); }
    if(visible.length) root.appendChild(node('div',{class:'ng-grid'},visible.map(function (it) { return tile(it,d); })));
    if(total>visible.length) {
      var more=button('Показать ещё '+Math.min(PAGE,total-visible.length),function () {
        shown+=PAGE; track('recs_more',{mode:mode,shown:Math.min(shown,total)});
        renderDetail(true);
        var next=document.querySelectorAll('#group-detail .ng-tile-open')[visible.length];
        if(next) next.focus({preventScroll:true});
      },'btn quiet ng-more');
      more.dataset.testid='ng-more';root.appendChild(more);
    }
    if(total) root.appendChild(node('p',{class:'ng-caption ng-foot',text:'Среди близких выше ароматы с хорошими оценками. Оценки Fragrantica на 20 сентября 2026.'}));
    window.scrollTo(0,y);
  }
  // Лист аромата: всё, что раньше занимало карточку, открывается по нажатию на плитку.
  function openRec(it,d) {
    var names=cleanName(it), root=$('rec-body');root.textContent='';
    $('rec-title').textContent=names.name;
    root.appendChild(strip(it.accords));
    root.appendChild(node('p',{class:'muted',text:names.brand}));
    root.appendChild(node('p',{class:'ng-caption ng-rating',text:ratingText(it.reputation,false)}));
    if(it.matches && it.matches.length) { root.appendChild(node('h3',{text:'Совпадает с вашей группой'})); root.appendChild(tags(it.matches)); }
    root.appendChild(node('p',{class:'ng-diff','data-diff':it.pid,text:difference(it)}));
    if(it.similar_to && it.similar_to.length) root.appendChild(node('p',{class:'ng-caption',text:'По характеру близок к '+it.similar_to.map(function (x) { return cleanName(x).name; }).join(' и ')+'.'}));
    var soldOut=d.stock_connected && !it.offer;
    if(d.stock_connected) root.appendChild(node('p',{class:'ng-price'+(soldOut?' is-out':''),text:'Отливант '+offerText(it)}));
    var add=addButton(it,d,samples.some(function (x) { return x.pid===it.pid; }),soldOut);
    add.classList.add('ng-wide');
    add.addEventListener('click',function () { setTimeout(function () { if(response===d) renderDetail(true); },0); });
    root.appendChild(add);
    open($('rec-sheet'));
  }
  // Меню «⋯»: поделиться, ссылка, изменить, удалить группу.
  function openMenu(g) {
    var root=$('menu-body');root.textContent='';
    $('menu-title').textContent=g.name;
    root.appendChild(button('Поделиться вкусом',function () { $('group-menu').close(); openShare(g); },'btn ng-wide'));
    root.appendChild(button(g.public_url?'Закрыть доступ по ссылке':'Открыть группу по ссылке',function () {
      $('group-menu').close();
      if(g.public_url) setPublic(g,false); else openShare(g);
    },'btn quiet ng-wide'));
    root.appendChild(button('Изменить состав и название',function () { $('group-menu').close(); editGroup(g); },'btn quiet ng-wide'));
    var del=button('Удалить группу',function () {
      if(del.dataset.confirm!=='1') { del.dataset.confirm='1'; del.textContent='Точно удалить «'+g.name+'»?'; return; }
      del.disabled=true;del.textContent='Удаляем…';
      api.request('DELETE','/v1/groups/'+g.id).then(function () {
        forget(g.id); groups=groups.filter(function (x) { return x.id!==g.id; }); renderGroups();
        $('group-menu').close(); backGroups(); message('Группа удалена');
      },function (e) { del.disabled=false;del.dataset.confirm='';del.textContent='Удалить группу';message(errorText(e)); });
    },'btn danger ng-wide');
    del.dataset.testid='ng-delete';root.appendChild(del);
    root.appendChild(node('p',{class:'ng-caption',text:'Удаление группы не трогает коллекцию и набор пробников.'}));
    open($('group-menu'));
  }
  function updateGroup(g) {
    groups=groups.map(function (x) { return x.id===g.id ? Object.assign({},x,{public_url:g.public_url}) : x; });
    MODES.forEach(function (m) { var c=cache[g.id+':'+m[0]]; if(c && c.data) c.data.group.public_url=g.public_url; });
    if(response && response.group.id===g.id) response.group.public_url=g.public_url;
  }
  function setPublic(g,on) {
    return api.request(on?'PUT':'DELETE','/v1/groups/'+g.id+'/public').then(function (d) {
      g.public_url=on ? d.url : null; updateGroup(g);
      if(on) track('group_published',{size:g.pids.length});
      message(on?'Группа открыта по ссылке':'Доступ по ссылке закрыт');
      return g;
    },function (e) { message(e && e.detail || errorText(e)); throw e; });
  }
  var storyUrl=null;
  // Лист «Поделиться»: карточка «Мой вкус в 3 нотах» для сторис и ссылка на группу.
  function openShare(g) {
    track('share_opened',{public:!!g.public_url});
    var root=$('share-body');root.textContent='';
    var figure=node('div',{class:'ng-story'},[node('p',{class:'ng-caption',text:'Рисуем картинку…'})]);
    var actions=node('div',{class:'ng-share-actions'});
    var linkBox=node('div',{class:'ng-link-box'});
    root.appendChild(figure);root.appendChild(actions);root.appendChild(linkBox);
    open($('share-sheet'));
    function renderLink() {
      linkBox.textContent='';
      if(g.public_url) {
        linkBox.appendChild(node('p',{class:'ng-link-title',text:'Группа открыта по ссылке'}));
        linkBox.appendChild(node('p',{class:'ng-link-url',text:g.public_url.replace(/^https?:\/\//,'')}));
        linkBox.appendChild(node('p',{class:'ng-caption',text:'В Instagram добавьте на сторис стикер «Ссылка» и вставьте этот адрес. Друзья увидят группу без регистрации.'}));
        var copy=button('Скопировать ссылку',function () {
          copyText(g.public_url).then(function () { message('Ссылка скопирована'); track('shared',{method:'link'}); },function () { message(g.public_url); });
        },'btn quiet ng-wide');
        copy.dataset.testid='ng-copy-link';linkBox.appendChild(copy);
        linkBox.appendChild(button('Закрыть доступ',function () { setPublic(g,false).then(function () { renderLink(); draw(); }); },'text-btn'));
      } else {
        linkBox.appendChild(node('p',{class:'ng-link-title',text:'Ссылка на группу'}));
        linkBox.appendChild(node('p',{class:'ng-caption',text:g.pids.length<2?'Добавьте в группу ещё один аромат, чтобы открыть её по ссылке.':'Друзья откроют группу и подборку НОТА без регистрации. Страницу видят только те, у кого есть ссылка.'}));
        var pub=button('Открыть по ссылке',function () {
          pub.disabled=true;pub.textContent='Готовим страницу…';
          setPublic(g,true).then(function () { renderLink(); draw(); },function () { pub.disabled=false;pub.textContent='Открыть по ссылке'; });
        },'btn ng-wide');
        pub.disabled=g.pids.length<2;pub.dataset.testid='ng-publish';linkBox.appendChild(pub);
      }
    }
    function draw() {
      if(!window.NotaStory) { figure.textContent='Картинка недоступна в этом браузере.'; return; }
      window.NotaStory.render({tags:g.tags,items:g.items.map(cleanName),groupName:g.name,url:g.public_url}).then(window.NotaStory.toBlob).then(function (blob) {
        if(storyUrl) URL.revokeObjectURL(storyUrl);
        storyUrl=URL.createObjectURL(blob);
        var file=new File([blob],'nota-moy-vkus.png',{type:'image/png'});
        figure.textContent='';
        figure.appendChild(node('img',{src:storyUrl,alt:'Картинка для сторис: мой вкус в 3 нотах','data-testid':'ng-story',width:'1080',height:'1920'}));
        figure.appendChild(node('p',{class:'ng-caption',text:'Можно нажать на картинку и удерживать, чтобы сохранить в фото.'}));
        actions.textContent='';
        var canShare=!!(navigator.canShare && navigator.share && navigator.canShare({files:[file]}));
        if(canShare) {
          var share=button('Поделиться',function () {
            // Ссылку кладём в буфер заранее: в Instagram её вставляют в стикер «Ссылка».
            if(g.public_url) copyText(g.public_url).catch(function () {});
            navigator.share({files:[file]}).then(function () { track('shared',{method:'share',public:!!g.public_url}); },function () {});
          },'btn ng-wide');
          share.dataset.testid='ng-share-system';actions.appendChild(share);
        }
        var save=node('a',{class:'btn '+(canShare?'quiet ':'')+'ng-wide',href:storyUrl,download:'nota-moy-vkus.png','data-testid':'ng-save-story',text:'Сохранить картинку'});
        save.addEventListener('click',function () { track('shared',{method:'save',public:!!g.public_url}); });
        actions.appendChild(save);
      },function () { figure.textContent='Не удалось нарисовать картинку. Попробуйте ещё раз.'; });
    }
    renderLink();draw();
  }
  function copyText(text) {
    if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area=node('textarea',{readonly:'readonly'});area.value=text;area.style.position='fixed';area.style.opacity='0';
      document.body.appendChild(area);area.select();
      var ok=false;try { ok=document.execCommand('copy'); } catch (e) { ok=false; }
      area.remove(); if(ok) resolve(); else reject(new Error('copy'));
    });
  }
  function modeSwitch(gid) {
    var seg=node('div',{class:'seg two ng-mode',role:'group','aria-label':'Какие ароматы показать','data-testid':'ng-mode'});
    MODES.forEach(function (m) {
      var b=button(m[1],function () {
        if(mode===m[0])return;
        mode=m[0]; showGroup(gid, true);
      },'');
      b.setAttribute('aria-pressed',String(mode===m[0]));b.dataset.mode=m[0];seg.appendChild(b);
    });
    return seg;
  }
  function lower(label) {
    // «Изо Е Супер» и другие названия из нескольких заглавных слов не трогаем.
    return /^[A-ZА-ЯЁ][a-zа-яё]/.test(label) && !/\s[A-ZА-ЯЁ]/.test(label) ? label.charAt(0).toLowerCase()+label.slice(1) : label;
  }
  function joinRu(list) {
    return list.length<2 ? list.join('') : list.slice(0,-1).join(', ')+' и '+list[list.length-1];
  }
  function difference(it) {
    var d=it.differences || {}, added=(d.added || []).map(function (t) { return lower(t.label); }), missing=(d.missing || []).map(function (t) { return lower(t.label); });
    var parts=[];
    // «В составе ещё» согласуется с любым числом нот, в отличие от «добавлены».
    if(added.length)parts.push('в составе ещё '+joinRu(added));
    if(missing.length)parts.push('нет '+(missing.length>1?'нот ':'ноты ')+joinRu(missing.map(function (x) { return '«'+x+'»'; })));
    return parts.length ? 'Чем отличается: '+parts.join('; ')+'.' : 'Почти тот же состав главных нот.';
  }
  function loadSamples() {
    return api.request('GET','/v1/samples').then(function (d) { samples=d.items;kit={mode:d.checkout_mode,bonus:d.bonus || {available:0,pending:0,percent:15}};renderSamples();if(response)renderDetail(); },function (e) {
      $('sample-list').textContent=errorText(e);$('sample-list').appendChild(button('Повторить',loadSamples));
    });
  }
  // Сумма набора считается по тому, что в нём сейчас лежит: после «В набор» и «Убрать» она сразу верная.
  // Аромат без цены (нет в наличии) в заявку не входит и в сумму не попадает.
  function kitTotal() { return samples.reduce(function (sum,x) { return sum+(x.offer?x.offer.price:0); },0); }
  // Два набора: Стандарт на 3 пробника и Экстра на 5. Оба видны сразу: места Экстра блёклые,
  // пока Стандарт не собран, чтобы человек с первого пробника знал, что можно взять и 5.
  // Пробники идут в наборы по порядку: после 5 начинается следующий набор, его тоже добирают
  // до 3 или 5. Заявка уходит, только когда последний набор собран (3, 5, 8, 10, 13, 15).
  // Правила те же, что на сервере (model-service/app/orders.py): сервер проверяет заново.
  var STANDARD = 3, EXTRA = 5;
  function kitItems() { return kit.mode==='order' ? samples.filter(function (x) { return x.offer; }) : samples; }
  function kitSets(n) {
    var full=Math.floor(n/EXTRA), cur=n%EXTRA;
    return {full:full, cur:cur, inSet:cur || (n ? EXTRA : 0), number:cur ? full+1 : Math.max(full,1)};
  }
  function kitReady(n) { return n>0 && (n%EXTRA===0 || n%EXTRA===STANDARD); }
  // 15% суммы каждого полного Экстра, округление вниз до рубля, как на сервере.
  function kitBonus() {
    var prices=kitItems().map(function (x) { return x.offer ? x.offer.price : 0; }), sum=0;
    for(var i=0;i+EXTRA<=prices.length;i+=EXTRA) sum+=Math.floor(prices.slice(i,i+EXTRA).reduce(function (a,b) { return a+b; },0)*kit.bonus.percent/100);
    return sum;
  }
  function kitStatus(n) {
    var k=kitSets(n), c=k.inSet, pre=k.number>1 && k.cur ? 'Набор '+k.number+' · ' : '';
    if(c<STANDARD) return pre+'Стандарт · '+c+' из '+STANDARD;
    if(c===STANDARD) return pre+'Стандарт собран';
    if(c<EXTRA) return pre+'Экстра · '+c+' из '+EXTRA;
    return k.full>1 ? k.full+' набора Экстра собраны' : 'Экстра собран';
  }
  function kitHint(n) {
    var k=kitSets(n), c=k.inSet, pct=kit.bonus.percent+'%', before=k.full && k.cur ? (k.full>1?k.full+' набора Экстра уже собраны. ':'Первый набор Экстра собран. ') : '';
    if(c<STANDARD) return before+'Ещё '+(STANDARD-c)+' до Стандарта. Можно взять и 5 пробников: за Экстра вернём '+pct+' бонусами.';
    if(c===STANDARD) return before+'Добавьте ещё 2, и получится Экстра: '+pct+' его суммы вернём бонусами на следующий заказ.';
    if(c<EXTRA) return before+'Ещё 1 до Экстра и '+pct+' бонусами.';
    return n>=EXTRA*3 ? 'Набор полный: больше 15 пробников в одну заявку не помещается.' : 'Можно оформить заявку или начать следующий набор на 3 или 5.';
  }
  // Пять точек: три места Стандарта и после небольшого зазора два места Экстра.
  function kitDots(n, cls) {
    var c=kitSets(n).inSet, row=node('span',{class:'ng-dots '+(cls || ''),'aria-hidden':'true'});
    for(var i=0;i<EXTRA;i++) row.appendChild(node('i',{class:(i<c?'is-on':'')+(i>=STANDARD?' is-extra':'')+(i===STANDARD?' is-gap':'')}));
    return row;
  }
  // Шкала текущего набора на вкладке «Пробники»: пять ячеек, подписи двух наборов и подсказка серым.
  // Собранные раньше наборы Экстра показаны строкой над шкалой.
  function kitMeter(n) {
    var k=kitSets(n), c=k.inSet, total=kitTotal();
    var bar=node('div',{class:'ng-meter-bar'+(c>=STANDARD?' is-standard':'')});
    for(var i=0;i<EXTRA;i++) bar.appendChild(node('i',{class:(i<c?'is-on':'')+(i>=STANDARD?' is-extra':'')+(i===STANDARD?' is-gap':'')}));
    var done=k.cur && k.full ? node('p',{class:'ng-meter-done',text:'✓ '+(k.full>1?k.full+' набора Экстра':'Экстра')+' · '+k.full*EXTRA+' пробников'}) : null;
    return node('section',{class:'ng-meter','aria-label':kitStatus(n)},[
      done,
      node('div',{class:'ng-meter-head'},[node('h2',{text:kitStatus(n)+(c===STANDARD || c===EXTRA?' ✓':'')}),total?node('b',{text:rub(total)}):null]),
      bar,
      node('div',{class:'ng-meter-labels','aria-hidden':'true'},[node('span',{class:c<=STANDARD?'is-current':'',text:'Стандарт · 3'}),node('span',{class:c>STANDARD?'is-current':'',text:'Экстра · 5 · +'+kit.bonus.percent+'%'})]),
      node('p',{class:'ng-meter-hint',text:kitHint(n)})]);
  }
  // Итог заявки: сумма, списание бонусов, к оплате и сколько бонусов придёт за Экстра.
  function kitSummary() {
    var total=kitTotal(), spend=Math.min(kit.bonus.available,total), earn=kitBonus(), rows=[];
    if(spend) {
      rows.push(node('p',{class:'ng-line ng-sum-line'},[node('span',{text:'Пробники'}),node('span',{text:rub(total)})]));
      rows.push(node('p',{class:'ng-line ng-sum-line'},[node('span',{text:'Бонусы'}),node('span',{text:'-'+rub(spend)})]));
    }
    rows.push(node('p',{class:'ng-total','data-kit-total':total-spend},[node('span',{text:spend?'К оплате':'Итого'}),node('b',{text:rub(total-spend)})]));
    if(earn) rows.push(node('p',{class:'ng-bonus',text:'+'+rub(earn)+' бонусами на следующий заказ. Начислим после получения этого.'}));
    else if(kit.bonus.pending && !kit.bonus.available) rows.push(node('p',{class:'ng-caption',text:rub(kit.bonus.pending)+' бонусами станут доступны после получения прошлого заказа.'}));
    return rows;
  }
  function renderKitBar() {
    var bar=$('kit-bar'); if(!bar) return;
    var onPicks=location.hash==='#/picks';
    var show=samples.length>0 && !onPicks;
    bar.hidden=!show;document.body.classList.toggle('has-kitbar',show);
    if(!show) return;
    var n=kitItems().length, text=$('kit-bar-text');
    text.textContent='';text.appendChild(kitDots(n));text.appendChild(node('span',{text:kitStatus(n)}));
    $('kit-bar-go').setAttribute('aria-label',kitStatus(n)+'. Открыть набор');
  }
  function renderSamples() {
    renderKitBar();
    var root=$('sample-list');root.textContent='';$('kit-badge').textContent=samples.length;$('kit-badge').hidden=!samples.length;
    if(!samples.length) {
      root.appendChild(node('p',{class:'ng-empty',text:'Здесь соберутся пробники из подборок по вашим группам.'}));
      root.appendChild(button('К моим группам',function () { location.hash='/taste'; },'btn'));return;
    }
    var n=kitItems().length;
    root.appendChild(kitMeter(n));
    samples.forEach(function (it) {
      var row=node('article',{class:'ng-sample','data-sample':it.pid},[perfume(it)]);
      if(it.group_name)row.appendChild(node('p',{class:'ng-caption',text:'Из группы «'+it.group_name+'»'}));
      if(kit.mode==='order')row.appendChild(node('p',{class:'ng-price'+(it.offer?'':' is-out'),text:it.offer?'Отливант '+offerText(it):'Нет в наличии, в заявку не войдёт'}));
      // Крестик в углу карточки вместо кнопки «Убрать»: меньше шума, тот же смысл.
      var remove=node('button',{type:'button',class:'ng-remove','data-testid':'ng-remove','aria-label':'Убрать '+cleanName(it).name+' из набора',text:'×',click:function () {
        remove.disabled=true;api.request('DELETE','/v1/samples/'+it.pid).then(function () { samples=samples.filter(function (x) { return x.pid!==it.pid; });renderSamples();if(response)renderDetail(); },function (e) { remove.disabled=false;message(errorText(e)); });
      }});
      row.appendChild(remove);root.appendChild(row);
    });
    // Последняя карточка ведёт к группам, где пробники и добавляются.
    root.appendChild(node('button',{type:'button',class:'ng-add-sample','data-testid':'ng-add-sample',click:function () { location.hash='/taste'; }},[
      node('span',{class:'ng-add-plus','aria-hidden':'true',text:'+'}),node('span',{text:'Добавить пробник'})]));
    if(kit.mode==='order') {
      kitSummary().forEach(function (x) { root.appendChild(x); });
      var ready=kitReady(n), c=kitSets(n).inSet;
      if(!ready) root.appendChild(node('p',{class:'ng-need',text:'Заявка оформляется набором из 3 или 5 пробников. Добавьте ещё '+(c<STANDARD?STANDARD-c:EXTRA-c)+'.'}));
      var go=button('Оформить заявку',checkout,'btn ng-wide');go.id='checkout';go.disabled=!ready;root.appendChild(go);
      root.appendChild(node('p',{class:'ng-caption',text:'Оплата наличными при получении. Менеджер позвонит и подтвердит состав и доставку.'}));
      return;
    }
    root.appendChild(node('p',{class:'ng-caption',text:'Тестовый набор. Цены и доступные объёмы появятся после подключения поставщика.'}));
    var preview=button('Посмотреть набор',previewSamples,'btn ng-wide');preview.id='preview-samples';root.appendChild(preview);
  }
  function checkout() {
    var root=$('sample-preview-body');root.textContent='';$('preview-title').textContent='Заявка на набор';
    var ready=samples.filter(function (x) { return x.offer; });
    ready.forEach(function (it) {
      root.appendChild(node('div',{class:'ng-line'},[perfume(it),node('span',{class:'ng-line-price',text:offerText(it)})]));
    });
    kitSummary().forEach(function (x) { root.appendChild(x); });
    var phone=node('input',{class:'field',id:'order-phone',type:'tel',inputmode:'tel',autocomplete:'tel',placeholder:'+7 999 123-45-67',maxlength:'30',required:'required'});
    var name=node('input',{class:'field',id:'order-name',autocomplete:'given-name',maxlength:'60',placeholder:'Как к вам обращаться'});
    var consent=node('input',{type:'checkbox',id:'order-consent'});
    var error=node('p',{class:'rx-err',id:'order-error',role:'alert'});
    var send=node('button',{class:'btn ng-wide',type:'submit',id:'order-send',text:'Отправить заявку'});
    var form=node('form',{class:'ng-order',novalidate:'novalidate'},[
      node('label',{class:'field-label',for:'order-phone',text:'Телефон'}),phone,
      node('label',{class:'field-label',for:'order-name',text:'Имя (необязательно)'}),name,
      node('label',{class:'ng-consent',for:'order-consent'},[consent,node('span',{},[document.createTextNode('Согласен на обработку номера телефона, чтобы со мной связались по заявке. '),node('a',{href:'./privacy.html',target:'_blank',rel:'noopener',text:'Как мы храним данные'})])]),
      error,send]);
    form.addEventListener('submit',function (ev) {
      ev.preventDefault();error.textContent='';
      var digits=phone.value.replace(/\D/g,'');
      if(digits.length<10) { error.textContent='Введите номер телефона полностью';phone.focus();return; }
      if(!consent.checked) { error.textContent='Отметьте согласие, без него мы не сможем позвонить';return; }
      send.disabled=true;send.textContent='Отправляем…';
      api.request('POST','/v1/orders',{phone:phone.value,name:name.value,consent:true}).then(function (d) {
        track('order_sent',{count:ready.length});
        root.textContent='';
        root.appendChild(node('h3',{class:'ng-done',text:'Заявка №'+d.number+' принята'}));
        root.appendChild(node('p',{text:'Позвоним на '+d.phone.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/,'+7 $1 $2-$3-$4')+', чтобы подтвердить состав и доставку. К оплате '+rub(d.to_pay!=null?d.to_pay:d.total)+(d.bonus_spent?' с учётом '+rub(d.bonus_spent)+' бонусами':'')+', оплата наличными при получении.'}));
        if(d.bonus_earned) root.appendChild(node('p',{class:'ng-bonus',text:'+'+rub(d.bonus_earned)+' бонусами начислим после получения заказа. Они спишутся со следующей заявки.'}));
        root.appendChild(button('Готово',function () { $('sample-preview').close(); },'btn ng-wide'));
        loadSamples();
      },function (e) {
        send.disabled=false;send.textContent='Отправить заявку';
        error.textContent=e && e.detail || (e && e.status===429 ? 'Сейчас много заявок, попробуйте чуть позже' : 'Не удалось отправить заявку. Проверьте связь и попробуйте ещё раз');
      });
    });
    root.appendChild(form);open($('sample-preview'));
  }
  function previewSamples() {
    var root=$('sample-preview-body');root.textContent='';$('preview-title').textContent='Ваш набор пробников';
    samples.forEach(function (it) { root.appendChild(perfume(it)); });
    root.appendChild(node('p',{class:'ng-caption',text:'Тестовое оформление, без оплаты и отправки заказа. Состав уже сохранён.'}));
    var confirm=button('Подтвердить тестовый набор',function () {
      root.textContent='';root.appendChild(node('h3',{text:'Набор собран'}));root.appendChild(node('p',{text:'Вы прошли путь до заказа. Ваши пробники сохранены во вкладке «Пробники». Оплата не списывалась, заказ не отправлен.'}));
      root.appendChild(button('Вернуться к набору',function () { $('sample-preview').close(); },'btn'));
    },'btn ng-wide');confirm.id='confirm-sample-preview';root.appendChild(confirm);open($('sample-preview'));
  }
  if($('kit-bar-go')) $('kit-bar-go').addEventListener('click',function () { location.hash='/picks'; });
  updateEntry();navigate();loadGroups();loadSamples();
})();
