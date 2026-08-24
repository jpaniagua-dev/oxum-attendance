/*
 * Attendance kiosk.
 *
 * One tablet, one class, one session. Students tap their own name; the teacher
 * pushes the result to the school's sheet at the end. Interface copy is French
 * because students read it — everything else here is English.
 *
 * Ticks are written to localStorage the moment they happen. A kiosk gets
 * knocked, locked and refreshed mid-class, and a lost hour of attendance
 * cannot be reconstructed from anyone's memory.
 */

(function () {
  'use strict';

  var CONFIG = window.KIOSK_CONFIG || null;
  var DEMO = !CONFIG || !CONFIG.endpoint;

  var CATEGORY_LABELS = { active: 'Inscrits', trial: "Cours d'essai", helper: 'Aide' };
  var ROLE_LABELS = { leader: 'Leaders', follower: 'Followers' };
  var CATEGORY_ORDER = ['active', 'trial', 'helper'];

  var TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  var state = {
    date: null,
    courses: [],
    course: null,
    /** group key + row → true/false, the only source of truth for the UI. */
    marks: {},
    /** Walk-ins added on the tablet, not yet in the sheet. */
    additions: [],
    stale: false,
    sending: false
  };

  var el = {};

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function boot() {
    [
      'shell', 'notice', 'roster', 'course-title', 'session-date', 'tally-count',
      'tally-word', 'switch-course', 'footer-state', 'send', 'splash',
      'splash-title', 'splash-note', 'splash-retry', 'picker', 'picker-list',
      'picker-date', 'confirm', 'confirm-note', 'confirm-cancel', 'confirm-send',
      'walkin', 'walkin-form', 'walkin-name', 'walkin-error', 'walkin-cancel'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el['switch-course'].addEventListener('click', function () { showPicker(); });
    el.send.addEventListener('click', askToSend);
    el['confirm-cancel'].addEventListener('click', function () { hide(el.confirm); });
    el['confirm-send'].addEventListener('click', send);
    el['walkin-cancel'].addEventListener('click', function () { hide(el.walkin); });
    el['walkin-form'].addEventListener('submit', addWalkIn);
    el['splash-retry'].addEventListener('click', load);

    // KIOSK_PREVIEW is set by the artifact build: there is no worker to register.
    if ('serviceWorker' in navigator && !window.KIOSK_PREVIEW) {
      navigator.serviceWorker.register('sw.js').catch(function () {
        /* Offline caching is a bonus; the kiosk works without it. */
      });
    }

    load();
  }

  function load() {
    hide(el['splash-retry']);
    el['splash-title'].textContent = 'Présences';
    el['splash-note'].textContent = 'Chargement des cours…';
    show(el.splash);

    fetchSession()
      .then(function (payload) {
        state.date = payload.date;
        state.courses = payload.courses || [];
        state.stale = payload.stale === true;
        cacheSession(payload);

        if (!state.courses.length) {
          return fail('Aucun cours trouvé dans les classeurs.', false);
        }
        if (state.courses.length === 1) return openCourse(state.courses[0]);
        showPicker();
      })
      .catch(function (error) {
        fail(error.message, true);
      });
  }

  /** Live data when configured, the cached copy when the room has no network. */
  function fetchSession() {
    if (DEMO) return Promise.resolve(demoSession());

    var url = CONFIG.endpoint + '?token=' + encodeURIComponent(CONFIG.token) +
      '&date=' + encodeURIComponent(today());

    return fetch(url, { method: 'GET', redirect: 'follow' })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload.ok) throw new Error(payload.error || 'Réponse invalide.');
        return payload;
      })
      .catch(function (error) {
        var cached = readCache();
        if (cached) {
          cached.stale = true;
          return cached;
        }
        throw new Error(
          'Impossible de joindre le studio, et aucune liste n’est enregistrée sur ' +
          'cette tablette. Vérifie la connexion. (' + error.message + ')'
        );
      });
  }

  function fail(message, retry) {
    el['splash-title'].textContent = 'Ça n’a pas marché';
    el['splash-note'].textContent = message;
    toggleHidden(el['splash-retry'], !retry);
    show(el.splash);
  }

  // -------------------------------------------------------------------------
  // Course selection
  // -------------------------------------------------------------------------

  function showPicker() {
    el['picker-date'].textContent = longDate(state.date);
    el['picker-list'].textContent = '';

    state.courses.forEach(function (course) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'picker-item';

      var name = document.createElement('strong');
      name.textContent = course.title;
      button.appendChild(name);

      var note = document.createElement('span');
      note.textContent = course.hasSession
        ? countStudents(course) + ' élèves inscrits ou en essai'
        : 'Pas de colonne pour cette date';
      button.appendChild(note);

      button.addEventListener('click', function () { openCourse(course); });
      el['picker-list'].appendChild(button);
    });

    hide(el.splash);
    show(el.picker);
  }

  function openCourse(course) {
    state.course = course;
    state.additions = [];
    state.marks = restoreMarks(course);

    el['course-title'].textContent = course.title;
    el['session-date'].textContent = longDate(state.date);
    toggleHidden(el['switch-course'], state.courses.length < 2);

    hide(el.picker);
    hide(el.splash);
    show(el.shell);

    renderNotice();
    renderRoster();
    renderTally();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderNotice() {
    var course = state.course;

    if (!course.hasSession) {
      return setNotice(
        'Aucune colonne ne correspond à aujourd’hui dans le classeur' +
        (course.sessionLabels && course.sessionLabels.length
          ? ' (colonnes présentes : ' + course.sessionLabels.join(', ') + ').'
          : '.') +
        ' Ajoute la date au Sheet, puis recharge.',
        'error'
      );
    }
    if (state.stale) {
      return setNotice(
        'Liste chargée depuis la tablette, pas depuis le studio. Les présences ' +
        'seront envoyées dès le retour du réseau.',
        ''
      );
    }
    hide(el.notice);
  }

  function setNotice(message, kind) {
    el.notice.textContent = message;
    el.notice.className = 'notice' + (kind ? ' ' + kind : '');
    show(el.notice);
  }

  function renderRoster() {
    el.roster.textContent = '';

    orderedGroups(state.course).forEach(function (group) {
      if (!group.students.length) return;
      el.roster.appendChild(renderGroup(group));
    });

    el.roster.appendChild(renderWalkInPrompt());
  }

  function orderedGroups(course) {
    return course.groups.slice().sort(function (a, b) {
      var byCategory = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      if (byCategory !== 0) return byCategory;
      return a.role === b.role ? 0 : (a.role === 'leader' ? -1 : 1);
    });
  }

  function renderGroup(group) {
    var section = document.createElement('section');

    var head = document.createElement('div');
    head.className = 'group-head';

    var title = document.createElement('p');
    title.className = 'eyebrow';
    title.textContent = CATEGORY_LABELS[group.category] + ' — ' + ROLE_LABELS[group.role];
    head.appendChild(title);

    var count = document.createElement('span');
    count.className = 'group-count';
    count.id = 'count-' + group.key;
    count.textContent = groupTally(group);
    head.appendChild(count);

    section.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'grid';
    group.students.forEach(function (student) {
      grid.appendChild(renderName(group, student));
    });
    section.appendChild(grid);

    return section;
  }

  function renderName(group, student) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'name';
    button.setAttribute('aria-pressed', String(isPresent(group, student)));

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = student.name;
    button.appendChild(label);

    var box = document.createElement('span');
    box.className = 'box';
    box.innerHTML = TICK;
    button.appendChild(box);

    button.addEventListener('click', function () {
      var next = !isPresent(group, student);
      state.marks[markKey(group, student.row)] = next;
      button.setAttribute('aria-pressed', String(next));
      persistMarks();
      renderTally();
      var counter = document.getElementById('count-' + group.key);
      if (counter) counter.textContent = groupTally(group);
    });

    return button;
  }

  /** One prompt at the end of the list, so a walk-in never has to find a section. */
  function renderWalkInPrompt() {
    var section = document.createElement('section');

    var head = document.createElement('div');
    head.className = 'group-head';
    var title = document.createElement('p');
    title.className = 'eyebrow';
    title.textContent = 'Ton nom n’est pas là ?';
    head.appendChild(title);
    section.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'grid';

    state.additions.forEach(function (addition, index) {
      grid.appendChild(renderAddition(addition, index));
    });

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'name add';
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Je viens pour un essai';
    add.appendChild(label);
    var box = document.createElement('span');
    box.className = 'box';
    add.appendChild(box);
    add.addEventListener('click', openWalkIn);
    grid.appendChild(add);

    section.appendChild(grid);
    return section;
  }

  function renderAddition(addition, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'name';
    button.setAttribute('aria-pressed', 'true');

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = addition.name + ' · ' + ROLE_LABELS[addition.role].slice(0, -1);
    button.appendChild(label);

    var box = document.createElement('span');
    box.className = 'box';
    box.innerHTML = TICK;
    button.appendChild(box);

    // Tapping an added name removes it — the only way back out of a typo.
    button.addEventListener('click', function () {
      state.additions.splice(index, 1);
      renderRoster();
      renderTally();
    });

    return button;
  }

  function renderTally() {
    var total = countPresent();
    el['tally-count'].textContent = String(total);
    el['tally-word'].textContent = total > 1 ? 'présents' : 'présent';

    var blocked = !state.course.hasSession || state.sending;
    el.send.disabled = blocked;
    if (!state.sending && state.course.hasSession) {
      setFooter('Touche ton nom pour signaler ta présence.', '');
    }
  }

  function setFooter(message, kind) {
    el['footer-state'].textContent = message;
    el['footer-state'].className = 'footer-state' + (kind ? ' ' + kind : '');
  }

  // -------------------------------------------------------------------------
  // Walk-ins
  // -------------------------------------------------------------------------

  function openWalkIn() {
    el['walkin-form'].reset();
    hide(el['walkin-error']);
    show(el.walkin);
    el['walkin-name'].focus();
  }

  function addWalkIn(event) {
    event.preventDefault();

    var name = el['walkin-name'].value.trim().replace(/\s+/g, ' ');
    var role = (el['walkin-form'].elements['walkin-role'] || {}).value;
    if (!name || !role) return;

    var free = freeSlotsFor(role) - countAdditions(role);
    if (free <= 0) {
      el['walkin-error'].textContent =
        'Le classeur n’a plus de ligne libre pour les essais ' +
        ROLE_LABELS[role].toLowerCase() + '. Préviens ton prof.';
      show(el['walkin-error']);
      return;
    }

    state.additions.push({ name: name, role: role });
    hide(el.walkin);
    renderRoster();
    renderTally();
  }

  function freeSlotsFor(role) {
    var group = groupByKey(role + ':trial');
    return group ? group.freeSlots.length : 0;
  }

  function countAdditions(role) {
    return state.additions.filter(function (a) { return a.role === role; }).length;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  function askToSend() {
    var total = countPresent();
    el['confirm-note'].textContent =
      total + (total > 1 ? ' présents' : ' présent') + ' pour « ' + state.course.title +
      ' » le ' + longDate(state.date) + '. Les autres seront notés absents.';
    show(el.confirm);
  }

  function send() {
    hide(el.confirm);
    state.sending = true;
    el.send.disabled = true;
    setFooter('Envoi en cours…', '');

    var payload = buildPayload();

    submit(payload)
      .then(function (result) {
        state.sending = false;
        clearMarks();
        var message = DEMO
          ? 'Démonstration — rien n’a été écrit dans le Sheet'
          : 'Envoyé — ' + result.written + ' lignes écrites';
        if (!DEMO && result.added && result.added.length) {
          message += ', ' + result.added.length + ' essai(s) ajouté(s)';
        }
        if (result.rejected && result.rejected.length) {
          setNotice(
            result.rejected.length + ' ligne(s) n’ont pas pu être écrites, le ' +
            'classeur a changé depuis le chargement : ' +
            result.rejected.map(function (r) {
              return (r.name || 'ligne ' + r.row) + ' — ' + r.reason;
            }).join(' · '),
            'error'
          );
        }
        setFooter(message + '.', '');
        el.send.disabled = false;
      })
      .catch(function (error) {
        state.sending = false;
        el.send.disabled = false;
        queue(payload);
        setFooter(
          'Envoi impossible — gardé sur la tablette, réessaie plus tard. (' +
          error.message + ')',
          'error'
        );
      });
  }

  function buildPayload() {
    var marks = [];
    state.course.groups.forEach(function (group) {
      group.students.forEach(function (student) {
        marks.push({
          group: group.key,
          row: student.row,
          name: student.name,
          present: isPresent(group, student)
        });
      });
    });

    return {
      token: DEMO ? 'demo' : CONFIG.token,
      courseId: state.course.id,
      date: state.date,
      marks: marks,
      additions: state.additions.map(function (addition) {
        return { role: addition.role, name: addition.name, present: true };
      })
    };
  }

  function submit(payload) {
    if (DEMO) {
      return Promise.resolve({
        written: payload.marks.length,
        added: payload.additions,
        rejected: []
      });
    }

    // text/plain keeps this a simple request: Apps Script answers no preflight.
    return fetch(CONFIG.endpoint, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (!result.ok) throw new Error(result.error || 'Réponse invalide.');
        return result;
      });
  }

  // -------------------------------------------------------------------------
  // Local state
  // -------------------------------------------------------------------------

  function markKey(group, row) {
    return group.key + '#' + row;
  }

  function isPresent(group, student) {
    var key = markKey(group, student.row);
    if (key in state.marks) return state.marks[key] === true;
    return student.present === true;
  }

  function countPresent() {
    var total = state.additions.length;
    state.course.groups.forEach(function (group) {
      group.students.forEach(function (student) {
        if (isPresent(group, student)) total++;
      });
    });
    return total;
  }

  function groupTally(group) {
    var present = group.students.filter(function (student) {
      return isPresent(group, student);
    }).length;
    return present + ' / ' + group.students.length;
  }

  function countStudents(course) {
    return course.groups.reduce(function (total, group) {
      return total + group.students.length;
    }, 0);
  }

  function groupByKey(key) {
    var found = null;
    state.course.groups.forEach(function (group) {
      if (group.key === key) found = group;
    });
    return found;
  }

  function marksKey() {
    return 'kiosk.marks.' + state.course.id + '.' + state.date;
  }

  function persistMarks() {
    store(marksKey(), state.marks);
  }

  function restoreMarks(course) {
    var key = 'kiosk.marks.' + course.id + '.' + state.date;
    return read(key) || {};
  }

  function clearMarks() {
    try {
      window.localStorage.removeItem(marksKey());
    } catch (error) { /* private mode: nothing to clear */ }
    state.marks = {};
    state.additions = [];
    renderRoster();
    renderTally();
  }

  function cacheSession(payload) {
    if (payload.stale) return;
    store('kiosk.session', payload);
  }

  function readCache() {
    return read('kiosk.session');
  }

  /** Failed submissions are kept so a class is never silently lost. */
  function queue(payload) {
    var pending = read('kiosk.queue') || [];
    pending.push(payload);
    store('kiosk.queue', pending);
  }

  function store(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) { /* quota or private mode: the session still works in memory */ }
  }

  function read(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function today() {
    var now = new Date();
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function pad(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function longDate(iso) {
    var parts = String(iso || '').split('-');
    if (parts.length !== 3) return '';
    var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return date.toLocaleDateString('fr-CH', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  }

  function show(node) { node.hidden = false; }
  function hide(node) { node.hidden = true; }
  function toggleHidden(node, hidden) { node.hidden = hidden; }

  // -------------------------------------------------------------------------
  // Demo data — used when config.js is absent, so the interface can be looked
  // at without touching a real workbook. Names are invented.
  // -------------------------------------------------------------------------

  function demoSession() {
    var roster = function (names) {
      return names.map(function (name, index) {
        return { row: 12 + index, number: index + 1, name: name, present: false };
      });
    };
    var slots = function (count, from) {
      var free = [];
      for (var i = 0; i < count; i++) free.push({ row: from + i, number: i + 1 });
      return free;
    };

    return {
      ok: true,
      date: today(),
      courses: [
        {
          id: 'demo::Feuille 1::4',
          title: 'Julio & Diana - Inter-Avancé 1',
          hasSession: true,
          sessionLabels: ['25.08', '1.09', '8.09', '15.09', '22.09', '29.09'],
          groups: [
            {
              key: 'leader:active', role: 'leader', category: 'active',
              nameColumn: 3, sessionColumn: 4,
              students: roster(['Antoine H.', 'Basile P.', 'Cyril A.', 'Damien X.']),
              freeSlots: slots(3, 16)
            },
            {
              key: 'follower:active', role: 'follower', category: 'active',
              nameColumn: 13, sessionColumn: 14,
              students: roster(['Élodie S.', 'Fanny W. K.', 'Garance P.']),
              freeSlots: slots(4, 15)
            },
            {
              key: 'leader:trial', role: 'leader', category: 'trial',
              nameColumn: 3, sessionColumn: 4,
              students: roster(['Hector A.', 'Ivan']),
              freeSlots: slots(5, 24)
            },
            {
              key: 'follower:trial', role: 'follower', category: 'trial',
              nameColumn: 13, sessionColumn: 14,
              students: roster(['Jeanne O.', 'Karen B.', 'Lucie', 'Manon V.', 'Nine G.']),
              freeSlots: slots(2, 27)
            },
            {
              key: 'leader:helper', role: 'leader', category: 'helper',
              nameColumn: 3, sessionColumn: 4, students: [], freeSlots: slots(7, 34)
            },
            {
              key: 'follower:helper', role: 'follower', category: 'helper',
              nameColumn: 13, sessionColumn: 14, students: [], freeSlots: slots(7, 34)
            }
          ]
        },
        {
          id: 'demo::Feuille 1::42',
          title: 'Julio & Diana - Faux-Débutant 1',
          hasSession: true,
          sessionLabels: ['25.08', '1.09', '8.09', '15.09', '22.09', '29.09'],
          groups: [
            {
              key: 'leader:active', role: 'leader', category: 'active',
              nameColumn: 3, sessionColumn: 4,
              students: roster(['Olivier P.', 'Pierre S.', 'Quentin S.']),
              freeSlots: slots(4, 50)
            },
            {
              key: 'follower:active', role: 'follower', category: 'active',
              nameColumn: 13, sessionColumn: 14,
              students: roster(['Rose W.']),
              freeSlots: slots(6, 48)
            },
            {
              key: 'leader:trial', role: 'leader', category: 'trial',
              nameColumn: 3, sessionColumn: 4,
              students: roster(['Samuel', 'Théo', 'Ulysse H.', 'Victor L.']),
              freeSlots: slots(3, 60)
            },
            {
              key: 'follower:trial', role: 'follower', category: 'trial',
              nameColumn: 13, sessionColumn: 14,
              students: roster(['Wanda R.', 'Xénia C.', 'Yara', 'Zoé B.', 'Alix M.']),
              freeSlots: slots(2, 62)
            }
          ]
        }
      ]
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
