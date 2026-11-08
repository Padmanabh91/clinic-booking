// The three seeded doctors share one name, so tests pick them by id or specialty.
const SEEDED_NAME = 'Dr. Padmanabh';
const GENERAL_MEDICINE = { id: 1, name: SEEDED_NAME, specialty: 'General Medicine' }; // Monday to Friday
const DERMATOLOGY = { id: 2, name: SEEDED_NAME, specialty: 'Dermatology' }; // Monday, Wednesday, Friday
const PEDIATRICS = { id: 3, name: SEEDED_NAME, specialty: 'Pediatrics' }; // Tuesday, Thursday, Saturday

// How the app shows a doctor wherever one is listed or chosen.
const doctorLabel = ({ name, specialty }) => `${name} · ${specialty}`;

module.exports = { SEEDED_NAME, GENERAL_MEDICINE, DERMATOLOGY, PEDIATRICS, doctorLabel };
