/**
 * Valeurs par défaut modifiables depuis l'application (Paramètres).
 * Variables disponibles dans les modèles de messages :
 * {volontaire} {salle} {assemblee} {date} {date_relative} {responsable} {telephone_responsable}
 * {travaux} {taches} {consignes} {consignes_semaine} {questions}
 */
export const DEFAULT_PRE_TEMPLATE = `Bonjour Frère {volontaire},

Nous avons une intervention de maintenance prévue dans la Salle du Royaume de {salle} ({assemblee}) le {date}.

Peux-tu contacter le frère {responsable} au {telephone_responsable} afin de lui rappeler les travaux prévus et de vérifier les préparatifs ?

Travaux concernés :
{travaux}

Tâches à réaliser :
{taches}
{consignes}{consignes_semaine}
Merci de bien vouloir nous faire un retour après ton échange.`;

export const DEFAULT_POST_TEMPLATE = `Bonjour Frère {volontaire},

Concernant les travaux effectués {date_relative}, le {date}, dans la Salle du Royaume de {salle} ({assemblee}), pourrais-tu contacter le frère {responsable} au {telephone_responsable} pour avoir son retour sur le déroulement de l'intervention ?

Merci de lui poser les questions suivantes et de me transmettre ses réponses :
{questions}

Merci pour ton aide.`;

/** Champs du rapport mensuel (colonnes du modèle « Rapport de suivi SDR »). */
export const REPORT_FIELDS = [
  { key: 'weekly_cleaning', label: 'Nettoyage hebdomadaire' },
  { key: 'monthly_maintenance', label: 'Entretien mensuel' },
  { key: 'work_sheets', label: 'Fiches de travail' },
  { key: 'maintenance_calendar', label: 'Calendrier de maintenance' },
  { key: 'general_state', label: 'État général de la SDR' },
  { key: 'solutions', label: 'Solutions apportées' },
  { key: 'task_outcomes', label: 'Réalisation des tâches' },
  { key: 'expenses', label: 'Dépenses' },
  { key: 'recommendations', label: 'Recommandations' },
] as const;

export const DEFAULT_POST_QUESTIONS = [
  {
    label: 'Le nettoyage après chaque réunion est-il fait ? Sinon, pourquoi ?',
    type: 'yes_no', required: true, order: 1, category: 'Nettoyage hebdomadaire', reportField: 'weekly_cleaning',
  },
  {
    label: "L'entretien mensuel a-t-il été effectué ce mois ? Sinon, pourquoi ?",
    type: 'yes_no', required: true, order: 2, category: 'Entretien mensuel', reportField: 'monthly_maintenance',
  },
  {
    label: "La fiche d'entretien mensuel a-t-elle été utilisée ? (Demander une copie) Sinon, pourquoi ?",
    type: 'yes_no', required: true, order: 3, category: 'Entretien mensuel', reportField: 'monthly_maintenance',
  },
  {
    label: 'Les fiches de travail sont-elles utilisées ? Sinon, pourquoi ?',
    type: 'yes_no', required: true, order: 4, category: 'Fiches de travail', reportField: 'work_sheets',
  },
  {
    label: 'Le calendrier de maintenance est-il utilisé ? Sinon, pourquoi ?',
    type: 'yes_no', required: true, order: 5, category: 'Calendrier de maintenance', reportField: 'maintenance_calendar',
  },
  {
    label: 'La tâche « {tache} » a-t-elle été réalisée entièrement, partiellement ou pas du tout ?',
    type: 'status_list', required: true, order: 6, category: 'Tâches', perTask: true, reportField: 'task_outcomes',
    options: ['Réalisée', 'Partiellement réalisée', 'Non réalisée'],
  },
  {
    label: 'Y a-t-il un problème quelconque avec le bâtiment, les installations ou avec la maintenance/sécurité de la SDR ?',
    type: 'observations', required: true, order: 7, category: 'État général', reportField: 'general_state',
  },
  {
    label: 'Quelles solutions ont été apportées ou sont prévues pour ces problèmes ?',
    type: 'observations', required: false, order: 8, category: 'Solutions', reportField: 'solutions',
  },
  {
    label: 'Y a-t-il eu des dépenses ? Si oui, lesquelles et pour quel montant ?',
    type: 'amount', required: false, order: 9, category: 'Dépenses', reportField: 'expenses',
  },
];

export const DEFAULT_PRE_QUESTIONS = [
  { label: 'Le frère responsable a-t-il été joint ?', type: 'yes_no', required: true, order: 1, category: 'Contact' },
  { label: 'La date des travaux est-elle confirmée ?', type: 'yes_no', required: true, order: 2, category: 'Planning' },
  {
    label: 'Les préparatifs sont-ils prêts (matériel, produits, EPI) ?',
    type: 'status_list', required: true, order: 3, category: 'Préparatifs', options: ['Prêts', 'En partie', 'Pas prêts'],
  },
  { label: 'Des difficultés ou besoins particuliers ont-ils été signalés ?', type: 'observations', order: 4, category: 'Difficultés' },
];

/** Correspondance par défaut des 7 colonnes du modèle Word fourni. */
export const DEFAULT_REPORT_COLUMNS = [
  { index: 0, header: 'ASSEMBLEES', sources: ['event.label'] },
  { index: 1, header: 'Nettoyage Hebdomadaire', sources: ['answers:weekly_cleaning'] },
  { index: 2, header: 'Entretien Mensuel', sources: ['answers:monthly_maintenance', 'tasks.outcome'] },
  { index: 3, header: 'Fiches de Travail', sources: ['answers:work_sheets'] },
  { index: 4, header: 'Calendrier de Maintenance', sources: ['answers:maintenance_calendar'] },
  { index: 5, header: 'Etat Général de la SDR', sources: ['issues'] },
  { index: 6, header: 'Solutions Apportées', sources: ['solutions'] },
];
