// MOCK DATA ONLY. Fictional people, redacted phones. Nothing here comes from the CRM.
import type { OrbState } from 'thinking-orbs'

export type Role = 'employee' | 'admin'
export type Col = 'todo' | 'running' | 'review' | 'done'
export type Step = { label: string; orb: OrbState; tool: string; args: string; out: string; ms: number }
export type Template = {
  id: string
  title: string
  hint: string
  steps: Step[]
  approvals?: Omit<Approval, 'id' | 'taskId' | 'status'>[]
  summary: string
}
export type Task = {
  id: string; title: string; col: Col; tpl: string; step: number; when: string
  queued?: boolean; scheduled?: string; replay?: boolean; summary?: string
}
export type ApprovalStatus = 'pending' | 'sending' | 'sent' | 'blocked' | 'rejected'
export type Approval = {
  id: string; taskId: string; kind: 'whatsapp' | 'email' | 'crm'
  to: string; text: string; why: string
  field?: string; before?: string // CRM change: field, value before, new value in `text`
  policy: 'ok' | 'quiet' | 'window' // what the SERVER rules would decide, mocked
  status: ApprovalStatus; edited?: boolean
}
export type Memory = { id: string; text: string; kind: 'Règle' | 'Info'; by: string; at: string }
export type Idea = { id: string; title: string; body: string; action: string; tpl: string; why: string; task: string }

const s = (label: string, orb: OrbState, tool: string, args: string, out: string, ms: number): Step => ({ label, orb, tool, args, out, ms })

export const TEMPLATES: Template[] = [
  {
    id: 'relance', title: 'Relancer les clients sans réponse', hint: '5 conversations attendent une réponse',
    steps: [
      s('Je cherche les conversations sans réponse', 'searching', 'crm.find_conversations', '{ silentHours: ">24", limit: 20 }', '5 conversations', 840),
      s("Je relis l'historique de chaque client", 'working', 'crm.read_thread', '{ ids: [c_91, c_44, c_12, c_73, c_08] }', '5 fils lus, 38 messages', 2100),
      s('Je vérifie vos règles (heures calmes, premier contact)', 'weaving', 'policy.dry_run', '{ rules: "agency", n: 3 }', "1 message risque d'être bloqué", 310),
      s("J'écris un message adapté à chaque client", 'composing', 'llm.draft', '{ tone: "chaleureux", n: 3 }', '3 brouillons, 61 mots en moyenne', 4300),
      s('Je les place dans « À valider »', 'connecting', 'suggestion.create', '{ status: "PENDING_APPROVAL", n: 3 }', '3 propositions créées', 420),
    ],
    approvals: [
      { kind: 'whatsapp', to: 'Sofia M. · +212•••••42', text: "Bonjour Sofia, je reviens vers vous au sujet de l'appartement de Maarif. Souhaitez-vous toujours le visiter cette semaine ? Je vous propose jeudi à 15 h ou vendredi à 11 h.", why: "Sofia a demandé une visite il y a 2 jours et n'a pas eu de réponse.", policy: 'ok' },
      { kind: 'whatsapp', to: 'Yassine K. · +212•••••17', text: "Bonjour Yassine, avez-vous eu le temps de réfléchir au bien de Gauthier ? Je reste disponible pour répondre à vos questions.", why: 'Dernier message du client il y a 5 jours.', policy: 'window' },
      { kind: 'whatsapp', to: 'Mme Benali · +212•••••08', text: "Bonjour Madame Benali, le propriétaire accepte votre proposition de visite samedi à 10 h. Pouvez-vous me confirmer ?", why: "Le propriétaire a répondu hier, la cliente n'est pas encore au courant.", policy: 'ok' },
    ],
    summary: "3 relances préparées. Rien n'est parti : vous devez les approuver.",
  },
  {
    id: 'visites', title: 'Préparer les visites de demain', hint: '3 visites prévues demain',
    steps: [
      s("Je regarde l'agenda de demain", 'searching', 'calendar.list', '{ day: "tomorrow" }', '3 visites', 520),
      s('Je rassemble les dossiers des biens', 'working', 'crm.read_property', '{ ids: [p_21, p_07, p_33] }', '3 fiches, 14 photos', 1800),
      s('Je prépare un mémo par visite', 'composing', 'llm.draft', '{ kind: "visit_brief", n: 3 }', '3 mémos', 3900),
      s('Je prépare les rappels aux clients', 'composing', 'llm.draft', '{ kind: "visit_reminder", n: 1 }', '1 brouillon', 1500),
      s('Je les place dans « À valider »', 'connecting', 'suggestion.create', '{ status: "PENDING_APPROVAL", n: 1 }', '1 proposition créée', 400),
    ],
    approvals: [
      { kind: 'whatsapp', to: 'Omar T. · +212•••••63', text: "Bonjour Omar, petit rappel : nous visitons la villa de Californie demain à 10 h. Je vous attends devant le portail. À demain !", why: 'Visite demain à 10 h, rappel prévu la veille par vos règles.', policy: 'ok' },
    ],
    summary: 'Mémos prêts pour les 3 visites, 1 rappel client à valider.',
  },
  {
    id: 'dossier', title: "Résumer le dossier d'un client", hint: 'En 5 lignes, avec les prochaines étapes',
    steps: [
      s('Je retrouve le dossier du client', 'searching', 'crm.find_person', '{ name: "[nom masqué]" }', '1 fiche', 600),
      s('Je lis les échanges et les notes', 'working', 'crm.read_thread', '{ person: p_5 }', '24 messages, 3 notes', 2000),
      s("J'écris le résumé", 'composing', 'llm.summarize', '{ lines: 5 }', '5 lignes', 2800),
    ],
    summary: 'Résumé prêt : client sérieux, budget 1,2 M MAD, cherche un 3 pièces à Maarif, a visité 2 biens.',
  },
  {
    id: 'nouveaux', title: 'Répondre aux nouveaux contacts', hint: '2 nouveaux contacts WhatsApp cette nuit',
    steps: [
      s('Je lis les nouveaux messages', 'searching', 'wa.read_inbound', '{ since: "yesterday 21:00" }', '2 contacts', 700),
      s("Je cherche s'ils sont déjà dans le CRM", 'searching', 'crm.find_person', '{ phones: ["+212•••••55", "+212•••••90"] }', '0 doublon', 650),
      s("J'écris une réponse d'accueil", 'composing', 'llm.draft', '{ n: 2 }', '2 brouillons', 3100),
      s('Je les place dans « À valider »', 'connecting', 'suggestion.create', '{ status: "PENDING_APPROVAL", n: 2 }', '2 propositions', 400),
    ],
    approvals: [
      { kind: 'whatsapp', to: 'Nouveau contact · +212•••••55', text: "Bonjour et merci pour votre message ! Je suis Nadia de l'agence. Cherchez-vous à acheter ou à louer, et dans quel quartier ?", why: 'Nouveau lead arrivé à 23 h 40, aucune réponse envoyée.', policy: 'ok' },
      { kind: 'crm', to: 'Fiche contact · +212•••••55', text: 'Source : WhatsApp · Étape : Nouveau', field: 'Création de la fiche', before: 'Aucune fiche', why: "Ce numéro n'existe pas encore dans le CRM.", policy: 'ok' },
    ],
    summary: "2 réponses d'accueil et 1 fiche à valider.",
  },
  {
    id: 'annonce', title: "Rédiger l'annonce d'un bien", hint: 'Texte prêt à publier, à relire',
    steps: [
      s('Je lis la fiche du bien', 'working', 'crm.read_property', '{ id: p_07 }', '1 fiche', 800),
      s("J'écris l'annonce", 'composing', 'llm.draft', '{ kind: "listing", words: 120 }', '118 mots', 3600),
    ],
    summary: "Annonce rédigée (118 mots). Elle est enregistrée dans la fiche du bien, rien n'est publié.",
  },
  {
    id: 'point', title: 'Faire le point de la journée', hint: 'Ce qui est fait, ce qui reste',
    steps: [
      s('Je compte les messages et visites du jour', 'searching', 'crm.stats', '{ day: "today" }', '12 messages, 2 visites', 900),
      s("J'écris le résumé", 'composing', 'llm.summarize', '{ lines: 6 }', '6 lignes', 2400),
    ],
    summary: "Aujourd'hui : 12 messages traités, 2 visites faites, 3 relances en attente de votre accord.",
  },
  {
    id: 'signature', title: 'Rappeler la signature en attente', hint: '1 mandat attend une signature',
    steps: [
      s('Je retrouve le document en attente', 'searching', 'docs.pending_signature', '{ olderThanDays: 3 }', '1 mandat, envoyé il y a 4 jours', 640),
      s("J'écris un rappel poli", 'composing', 'llm.draft', '{ channel: "email" }', '1 brouillon', 2600),
      s('Je le place dans « À valider »', 'connecting', 'suggestion.create', '{ status: "PENDING_APPROVAL", n: 2 }', '2 propositions', 400),
    ],
    approvals: [
      { kind: 'email', to: 'm.alami@exemple.ma', text: "Objet : Mandat de vente, villa de Californie\n\nBonjour Monsieur Alami, je me permets de vous rappeler que le mandat envoyé le 2 attend votre signature. Il vous suffit d'ouvrir le lien reçu par e-mail. Je reste à votre disposition.", why: 'Mandat envoyé il y a 4 jours, aucune signature.', policy: 'ok' },
      { kind: 'crm', to: 'Mandat · Villa Californie', text: "Relance envoyée aujourd'hui", field: 'Suivi du mandat', before: 'Envoyé pour signature', why: 'Garder une trace de la relance dans le dossier.', policy: 'ok' },
    ],
    summary: "Rappel par e-mail et mise à jour du dossier à valider.",
  },
  {
    id: 'biens', title: 'Trouver des biens pour un client', hint: 'Selon son budget et ses critères',
    steps: [
      s('Je lis les critères du client', 'working', 'crm.read_demand', '{ person: p_5 }', 'Budget 1,2 M, 3 pièces, Maarif', 700),
      s('Je cherche dans vos biens', 'searching', 'crm.match_properties', '{ budget: 1200000, rooms: 3 }', '4 biens correspondent', 1200),
      s('Je classe les 3 meilleurs', 'weaving', 'llm.rank', '{ top: 3 }', '3 biens classés', 1800),
    ],
    summary: '3 biens proposés, du plus au moins proche de la demande.',
  },
  {
    id: 'libre', title: 'Votre demande', hint: '',
    steps: [
      s('Je lis votre demande', 'working', 'llm.plan', '{ text: "[texte masqué]" }', 'plan en 3 étapes', 900),
      s('Je cherche les informations utiles', 'searching', 'crm.search', '{ q: "[masqué]" }', '6 résultats', 1500),
      s('Je prépare une réponse', 'composing', 'llm.draft', '{ }', '1 brouillon', 2800),
    ],
    summary: "J'ai préparé une réponse. Elle n'est envoyée à personne.",
  },
]
export const tpl = (id: string) => TEMPLATES.find(t => t.id === id) ?? TEMPLATES[TEMPLATES.length - 1]
// Slice 1 starters: READ-ONLY requests that run for real. `edit`: needs a name, so it pre-fills the bar instead of running.
export type Starter = { id: string; title: string; hint: string; task: string; edit?: boolean }
export const STARTERS: Starter[] = [
  { id: 's1', title: 'Qui attend une réponse ?', hint: 'Sans réponse depuis 24 h', task: 'Quelles conversations attendent une réponse depuis plus de 24 h ?' },
  { id: 's2', title: 'Faire le point de la journée', hint: 'Ce qui est fait, ce qui reste', task: 'Fais le point de la journée : messages, visites, ce qui reste à faire.' },
  { id: 's3', title: "Résumer le dossier d'un client", hint: 'Il suffit de donner le nom', task: 'Résume en 5 lignes le dossier de ', edit: true },
  { id: 's4', title: 'Préparer les visites de demain', hint: 'Un mémo par visite', task: 'Prépare un mémo pour chacune des visites de demain.' },
]

export const INITIAL_TASKS: Task[] = [
  { id: 't3', title: 'Préparer les visites de demain', col: 'running', tpl: 'visites', step: 1, when: 'Démarré il y a 1 min' },
  { id: 't4', title: 'Faire le point de la semaine', col: 'todo', tpl: 'point', step: 0, when: 'Prévu à 18 h', scheduled: '18 h' },
  { id: 't1', title: 'Relancer les clients sans réponse', col: 'review', tpl: 'relance', step: 5, when: 'Il y a 12 min', summary: tpl('relance').summary },
  { id: 't2', title: 'Rappeler la signature en attente', col: 'review', tpl: 'signature', step: 3, when: 'Il y a 40 min', summary: tpl('signature').summary },
  { id: 't5', title: 'Résumer le dossier de M. Alami', col: 'done', tpl: 'dossier', step: 3, when: 'Ce matin, 9 h 12', summary: tpl('dossier').summary },
  { id: 't6', title: 'Répondre aux nouveaux contacts', col: 'done', tpl: 'nouveaux', step: 4, when: 'Hier, 17 h 03', summary: '1 réponse envoyée après accord.' },
]

const A = (id: string, taskId: string, i: number, tid: string): Approval => ({ id, taskId, status: 'pending', ...tpl(tid).approvals![i] })
export const INITIAL_APPROVALS: Approval[] = [
  A('a1', 't1', 0, 'relance'), A('a2', 't1', 1, 'relance'), A('a3', 't1', 2, 'relance'),
  A('a4', 't2', 0, 'signature'), A('a5', 't2', 1, 'signature'),
  { ...A('a0', 't6', 0, 'nouveaux'), status: 'sent' },
]

export const INITIAL_MEMORY: Memory[] = [
  { id: 'm1', kind: 'Règle', text: 'Ne jamais écrire à un client après 21 h ni avant 9 h.', by: 'Hamza (admin)', at: 'il y a 3 jours' },
  { id: 'm2', kind: 'Règle', text: "Toujours vouvoyer les clients, sauf s'ils tutoient d'abord.", by: 'Nadia (employée)', at: 'il y a 1 semaine' },
  { id: 'm3', kind: 'Règle', text: 'Ne jamais donner un prix ferme par message : proposer un appel.', by: 'Hamza (admin)', at: 'il y a 2 semaines' },
  { id: 'm4', kind: 'Info', text: "L'agence ouvre du lundi au samedi, de 9 h à 19 h.", by: 'Hamza (admin)', at: 'il y a 1 mois' },
  { id: 'm5', kind: 'Info', text: 'Les visites durent 30 minutes. Prévoir 15 minutes de trajet entre deux visites.', by: 'Nadia (employée)', at: 'il y a 1 mois' },
]

export const IDEAS: Idea[] = [
  { id: 'i1', title: '5 conversations WhatsApp attendent une réponse', body: "La plus ancienne date de 5 jours. Je peux vous les lister.", action: 'Voir avec Laya', tpl: 'relance', why: "Le dernier message de ces clients date de plus de 24 h et personne n'a répondu. C'est une de vos règles : répondre sous 24 h. Je ne fais que lire, je n'envoie rien.", task: "Quelles conversations WhatsApp attendent une réponse ? Donne la plus ancienne en premier." },
  { id: 'i2', title: '3 visites demain, dont une à 10 h', body: 'Je peux préparer un mémo par visite.', action: 'Voir avec Laya', tpl: 'visites', why: "Vous avez 3 visites à l'agenda demain. Un mémo par visite aide à les préparer.", task: "Prépare un mémo pour chacune des visites de demain." },
  { id: 'i3', title: 'Un mandat attend une signature depuis 4 jours', body: "Villa de Californie : M. Alami n'a pas encore signé.", action: 'Voir avec Laya', tpl: 'signature', why: "Le document a été envoyé le 2 et n'est toujours pas signé. Au-delà de 3 jours, un rappel augmente souvent les chances de signature (à faire par vous pour l'instant).", task: "Quels mandats attendent une signature depuis plus de 3 jours ?" },
  { id: 'i4', title: '2 nouveaux contacts sont arrivés cette nuit', body: "Aucune réponse n'est partie. Voulez-vous les voir ?", action: 'Voir avec Laya', tpl: 'nouveaux', why: "Deux personnes vous ont écrit après la fermeture. Répondre vite augmente les chances de rendez-vous.", task: "Y a-t-il de nouveaux contacts WhatsApp arrivés cette nuit ?" },
]
