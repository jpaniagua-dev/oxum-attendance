import { Injectable, computed, effect, signal } from '@angular/core';

export type Lang = 'fr' | 'en';

const KEY = 'attendance.lang';

/**
 * French is the source of truth: it is the language the school runs in and the
 * one every string was written for. English exists because a good share of the
 * students are more comfortable in it, and they are the ones handed the phone.
 *
 * Angular's own i18n is compile-time and would mean a second bundle behind a
 * second URL. A student switching language mid-class cannot wait for that, so
 * the dictionary is loaded with the app and swapped by a signal.
 */
const FR = {
  'common.studio': 'Bachata Geneva Dance Studio',
  'common.cancel': 'Annuler',
  'common.back': 'Retour',
  'common.settings': 'Réglages',
  'common.retry': 'Réessayer',
  'common.stale':
    "Liste chargée depuis cet appareil. Les présences partiront dès le retour du réseau.",

  'conflict.title': 'Le classeur a changé',
  'conflict.body':
    "Ces présences n'ont pas pu être écrites, parce que la ligne n'est plus la même dans le Google Sheet. La liste vient d'être rechargée : il faut les recocher.",
  'conflict.ok': "J'ai compris",

  'courses.title': 'Quel cours ?',
  'courses.loading': 'Chargement…',
  'courses.students': '{n} élèves',
  'courses.noSession': 'Pas de colonne pour cette date',
  'courses.none':
    "Aucun cours visible aujourd'hui. Ajoute un classeur ou réaffiche un cours masqué depuis les réglages.",
  'courses.unreachable':
    "Classeur « {name} » inaccessible. Vérifie qu'il est toujours partagé avec le compte Google qui a déployé le script.",

  'roster.changeCourse': 'Changer de cours',
  'roster.search': 'Cherche ton nom…',
  'roster.searchLabel': 'Chercher un nom',
  'roster.clear': 'Effacer',
  'roster.present': 'Présents',
  'roster.waiting': 'Attendus',
  'roster.hereOne': 'présent',
  'roster.hereMany': 'présents',
  'roster.noColumn':
    "Aucune colonne ne correspond à aujourd'hui dans le classeur. Ajoute la date dans le Google Sheet, puis recharge.",
  'roster.columns': 'Colonnes présentes : {list}.',
  'roster.demo': 'Démonstration.',
  'roster.demoBody': "Noms inventés, rien n'est écrit dans un Google Sheet.",
  'roster.nothingFound': 'Aucun nom ne correspond à « {q} ».',
  'roster.emptyCourse': "Aucun élève dans ce cours pour l'instant.",
  'roster.walkin': 'Je ne suis pas dans la liste',
  'roster.loading': 'Chargement du cours…',
  'roster.gone': "Ce cours n'est plus dans la liste.",
  'roster.backToCourses': 'Retour aux cours',

  'sync.sending': 'Envoi…',
  'sync.pending': '{n} en attente',
  'sync.offline': 'Hors ligne',
  'sync.idle': 'À jour',

  'untick.title': '{name} est noté présent',
  'untick.body': 'Retirer cette présence ? Le classeur sera mis à jour tout de suite.',
  'untick.confirm': 'Retirer',

  'walkin.title': "Cours d'essai",
  'walkin.hint': "Ton prénom et l'initiale de ton nom suffisent.",
  'walkin.name': 'Nom',
  'walkin.namePlaceholder': 'Camille B.',
  'walkin.roleLegend': 'Je danse en',
  'walkin.places': '{n} places',
  'walkin.error': 'Il faut un nom et un rôle.',
  'walkin.full': "Plus de ligne libre pour les essais {role}.",
  'walkin.noBlock': "Ce cours n'a pas de bloc d'essai utilisable aujourd'hui.",
  'walkin.submit': 'Je suis là',

  'note.open': 'Commentaire',
  'note.title': 'Commentaire sur {name}',
  'note.hint':
    "Écrit dans la colonne Commentaires du classeur, à côté du nom. Visible par l'école. Vide le champ pour effacer la note.",
  'note.placeholder': 'danse en fait leader',
  'note.save': 'Enregistrer',

  'settings.title': 'Réglages',
  'settings.lock': 'Verrouiller',

  'gate.title': 'Code à quatre chiffres',
  'gate.body':
    "Les réglages sont protégés parce que l'appareil passe de main en main pendant le cours.",
  'gate.code': 'Code',
  'gate.wrong': 'Code incorrect.',
  'gate.open': 'Ouvrir',

  'conn.title': 'Connexion au studio',
  'conn.body':
    "L'URL du déploiement Apps Script et son jeton. Ces deux valeurs sont propres à cet appareil.",
  'conn.url': 'URL de déploiement',
  'conn.token': 'Jeton',
  'conn.pin': 'Code des réglages',
  'conn.pinUnchanged': 'Inchangé',
  'conn.pinNew': '4 chiffres',
  'conn.pinHintSet': 'Laisse vide pour garder le code actuel.',
  'conn.pinHintNone': "Sans code, n'importe qui peut ouvrir cette page depuis le cours.",
  'conn.test': 'Tester',
  'conn.testing': 'Test…',
  'conn.save': 'Enregistrer',
  'conn.connected': 'Connecté — fuseau {tz}.',
  'conn.saved': 'Réglages enregistrés.',

  'theme.title': 'Apparence',
  'theme.body':
    "« Appareil » suit le réglage du téléphone : clair en journée, sombre le soir, sans rien toucher.",
  'theme.system': 'Appareil',
  'theme.light': 'Clair',
  'theme.dark': 'Sombre',

  'lang.title': 'Langue',

  'books.title': 'Classeurs Google Sheets',
  'books.body':
    "Un classeur par binôme. Ajoute celui d'un nouveau cours en collant son lien ; il doit être partagé en édition avec le compte Google qui a déployé le script. La liste est commune à tous les appareils.",
  'books.loading': 'Chargement…',
  'books.remove': 'Retirer',
  'books.noCourses': 'Aucun cours reconnu',
  'books.addLabel': 'Ajouter un classeur',
  'books.add': 'Ajouter',
  'books.checking': 'Vérification…',

  'vis.title': 'Cours affichés',
  'vis.body':
    "Un classeur peut contenir des cours donnés par quelqu'un d'autre. Masque ceux qui ne sont pas les tiens : ils restent intacts dans le Sheet.",
  'vis.shown': 'Affiché',
  'vis.hidden': 'Masqué',
  'vis.none': "Aucun cours chargé pour l'instant.",

  'demo.title': 'Essayer sans classeur',
  'demo.body':
    "Charge une salle fictive pour regarder l'interface et la faire essayer, sans toucher au moindre Google Sheet.",
  'demo.start': 'Lancer la démonstration',
  'demo.leave': 'Quitter la démonstration',
  'demo.banner': 'Mode démonstration.',
  'demo.bannerBody':
    "Les noms sont inventés et rien n'est écrit dans un Google Sheet. Saisis l'URL de déploiement ci-dessus pour passer en réel.",
  'demo.on': 'Mode démonstration activé.',

  'install.title': "Installer sur l'appareil",
  'install.body':
    "Depuis le navigateur : menu « Partager » puis « Sur l'écran d'accueil » sur iPhone et iPad, ou « Installer l'application » sur Android.",

  'remove.title': 'Retirer ce classeur ?',
  'remove.body':
    "« {name} » disparaîtra de l'app, sur tous les appareils. Le Google Sheet et son contenu ne sont pas touchés, et tu peux le rajouter avec son lien.",

  'roster.trial': 'Essai',

  'role.leaders': 'Leaders',
  'role.followers': 'Followers',
  'role.leader': 'Leader',
  'role.follower': 'Follower',

  'error.unconfigured': "L'app n'est pas encore configurée.",
  'error.badResponse':
    "Réponse inattendue du serveur. Vérifie l'URL de déploiement dans les réglages.",
  'error.unknown': 'Erreur inconnue.',
  'error.offline':
    "Impossible de joindre le studio, et aucune liste n'est enregistrée sur cet appareil.",
} as const;

export type MessageKey = keyof typeof FR;

/** Typed as a full record, so a forgotten key fails the build rather than the class. */
const EN: Record<MessageKey, string> = {
  'common.studio': 'Bachata Geneva Dance Studio',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.settings': 'Settings',
  'common.retry': 'Try again',
  'common.stale':
    'List loaded from this device. Attendance will be sent as soon as the network is back.',

  'conflict.title': 'The workbook changed',
  'conflict.body':
    'These could not be written, because the row is no longer the same in the Google Sheet. The list has just been reloaded — they need ticking again.',
  'conflict.ok': 'Got it',

  'courses.title': 'Which class?',
  'courses.loading': 'Loading…',
  'courses.students': '{n} students',
  'courses.noSession': 'No column for this date',
  'courses.none':
    'No class showing today. Add a workbook, or unhide a class from the settings.',
  'courses.unreachable':
    'Workbook “{name}” cannot be opened. Check it is still shared with the Google account that deployed the script.',

  'roster.changeCourse': 'Change class',
  'roster.search': 'Find your name…',
  'roster.searchLabel': 'Search for a name',
  'roster.clear': 'Clear',
  'roster.present': 'Here',
  'roster.waiting': 'Expected',
  'roster.hereOne': 'here',
  'roster.hereMany': 'here',
  'roster.noColumn':
    "No column matches today's date in the workbook. Add the date to the Google Sheet, then reload.",
  'roster.columns': 'Columns present: {list}.',
  'roster.demo': 'Demo.',
  'roster.demoBody': 'Invented names, nothing is written to a Google Sheet.',
  'roster.nothingFound': 'No name matches “{q}”.',
  'roster.emptyCourse': 'No students in this class yet.',
  'roster.walkin': "I'm not on the list",
  'roster.loading': 'Loading the class…',
  'roster.gone': 'This class is no longer in the list.',
  'roster.backToCourses': 'Back to classes',

  'sync.sending': 'Sending…',
  'sync.pending': '{n} waiting',
  'sync.offline': 'Offline',
  'sync.idle': 'Up to date',

  'untick.title': '{name} is marked here',
  'untick.body': 'Remove this attendance? The workbook will be updated straight away.',
  'untick.confirm': 'Remove',

  'walkin.title': 'Trial class',
  'walkin.hint': 'Your first name and the initial of your surname are enough.',
  'walkin.name': 'Name',
  'walkin.namePlaceholder': 'Camille B.',
  'walkin.roleLegend': 'I dance as',
  'walkin.places': '{n} places',
  'walkin.error': 'A name and a role are needed.',
  'walkin.full': 'No free row left for {role} trials.',
  'walkin.noBlock': 'This class has no usable trial block today.',
  'walkin.submit': "I'm here",

  'note.open': 'Note',
  'note.title': 'Note about {name}',
  'note.hint':
    "Written into the workbook's Commentaires column, next to the name. Visible to the school. Empty the field to clear the note.",
  'note.placeholder': 'actually dances as a leader',
  'note.save': 'Save',

  'settings.title': 'Settings',
  'settings.lock': 'Lock',

  'gate.title': 'Four-digit code',
  'gate.body': 'Settings are protected because the device is passed around during class.',
  'gate.code': 'Code',
  'gate.wrong': 'Wrong code.',
  'gate.open': 'Open',

  'conn.title': 'Studio connection',
  'conn.body':
    'The Apps Script deployment URL and its token. Both belong to this device only.',
  'conn.url': 'Deployment URL',
  'conn.token': 'Token',
  'conn.pin': 'Settings code',
  'conn.pinUnchanged': 'Unchanged',
  'conn.pinNew': '4 digits',
  'conn.pinHintSet': 'Leave empty to keep the current code.',
  'conn.pinHintNone': 'Without a code, anyone can open this page during class.',
  'conn.test': 'Test',
  'conn.testing': 'Testing…',
  'conn.save': 'Save',
  'conn.connected': 'Connected — time zone {tz}.',
  'conn.saved': 'Settings saved.',

  'theme.title': 'Appearance',
  'theme.body':
    '“Device” follows the phone: light during the day, dark in the evening, with nothing to do.',
  'theme.system': 'Device',
  'theme.light': 'Light',
  'theme.dark': 'Dark',

  'lang.title': 'Language',

  'books.title': 'Google Sheets workbooks',
  'books.body':
    'One workbook per teaching pair. Add a new class by pasting its link; it must be shared with edit rights with the Google account that deployed the script. The list is shared by every device.',
  'books.loading': 'Loading…',
  'books.remove': 'Remove',
  'books.noCourses': 'No class recognised',
  'books.addLabel': 'Add a workbook',
  'books.add': 'Add',
  'books.checking': 'Checking…',

  'vis.title': 'Classes shown',
  'vis.body':
    "A workbook can hold classes taught by someone else. Hide the ones that are not yours — they stay untouched in the sheet.",
  'vis.shown': 'Shown',
  'vis.hidden': 'Hidden',
  'vis.none': 'No class loaded yet.',

  'demo.title': 'Try it without a workbook',
  'demo.body':
    'Loads a made-up class so the interface can be looked at and handed around, without touching any Google Sheet.',
  'demo.start': 'Start the demo',
  'demo.leave': 'Leave the demo',
  'demo.banner': 'Demo mode.',
  'demo.bannerBody':
    'Names are invented and nothing is written to a Google Sheet. Enter the deployment URL above to go live.',
  'demo.on': 'Demo mode on.',

  'install.title': 'Install on the device',
  'install.body':
    'From the browser: Share → “Add to Home Screen” on iPhone and iPad, or “Install app” on Android.',

  'remove.title': 'Remove this workbook?',
  'remove.body':
    '“{name}” will disappear from the app, on every device. The Google Sheet and its contents are untouched, and you can add it back with its link.',

  'roster.trial': 'Trial',

  'role.leaders': 'Leaders',
  'role.followers': 'Followers',
  'role.leader': 'Leader',
  'role.follower': 'Follower',

  'error.unconfigured': 'The app is not configured yet.',
  'error.badResponse':
    'Unexpected response from the server. Check the deployment URL in the settings.',
  'error.unknown': 'Unknown error.',
  'error.offline':
    'Cannot reach the studio, and no list is stored on this device.',
};

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { fr: FR, en: EN };

/** Date formatting follows the same choice, or dates stay stubbornly French. */
const LOCALES: Record<Lang, string> = { fr: 'fr-CH', en: 'en-GB' };

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly current = signal<Lang>(read());

  readonly lang = this.current.asReadonly();
  readonly locale = computed(() => LOCALES[this.current()]);

  constructor() {
    effect(() => document.documentElement.setAttribute('lang', this.current()));
  }

  set(lang: Lang): void {
    this.current.set(lang);
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      // Private mode: the choice still holds for this session.
    }
  }

  /** Reads the language signal, so any template calling it re-renders on change. */
  t(key: MessageKey, params?: Record<string, string | number>): string {
    const text = DICTIONARIES[this.current()][key];
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      name in params ? String(params[name]) : whole,
    );
  }
}

function read(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'fr' || stored === 'en') return stored;
    // A phone set to English gets English; anything else falls back to French.
    return navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'fr';
  } catch {
    return 'fr';
  }
}
