/** GST state / union territory codes (first two digits of a GSTIN), with the name in English and Tamil. */
export const STATES: Record<string, { name: string; name_ta: string }> = {
  '01': { name: 'Jammu and Kashmir', name_ta: 'ஜம்மு காஷ்மீர்' },
  '02': { name: 'Himachal Pradesh', name_ta: 'இமாச்சலப் பிரதேசம்' },
  '03': { name: 'Punjab', name_ta: 'பஞ்சாப்' },
  '04': { name: 'Chandigarh', name_ta: 'சண்டிகர்' },
  '05': { name: 'Uttarakhand', name_ta: 'உத்தராகண்ட்' },
  '06': { name: 'Haryana', name_ta: 'ஹரியானா' },
  '07': { name: 'Delhi', name_ta: 'டெல்லி' },
  '08': { name: 'Rajasthan', name_ta: 'ராஜஸ்தான்' },
  '09': { name: 'Uttar Pradesh', name_ta: 'உத்தரப் பிரதேசம்' },
  '10': { name: 'Bihar', name_ta: 'பீகார்' },
  '11': { name: 'Sikkim', name_ta: 'சிக்கிம்' },
  '12': { name: 'Arunachal Pradesh', name_ta: 'அருணாச்சலப் பிரதேசம்' },
  '13': { name: 'Nagaland', name_ta: 'நாகாலாந்து' },
  '14': { name: 'Manipur', name_ta: 'மணிப்பூர்' },
  '15': { name: 'Mizoram', name_ta: 'மிசோரம்' },
  '16': { name: 'Tripura', name_ta: 'திரிபுரா' },
  '17': { name: 'Meghalaya', name_ta: 'மேகாலயா' },
  '18': { name: 'Assam', name_ta: 'அசாம்' },
  '19': { name: 'West Bengal', name_ta: 'மேற்கு வங்காளம்' },
  '20': { name: 'Jharkhand', name_ta: 'ஜார்க்கண்ட்' },
  '21': { name: 'Odisha', name_ta: 'ஒடிசா' },
  '22': { name: 'Chhattisgarh', name_ta: 'சத்தீஸ்கர்' },
  '23': { name: 'Madhya Pradesh', name_ta: 'மத்தியப் பிரதேசம்' },
  '24': { name: 'Gujarat', name_ta: 'குஜராத்' },
  '26': { name: 'Dadra and Nagar Haveli and Daman and Diu', name_ta: 'தாத்ரா நகர் ஹவேலி மற்றும் டாமன் டையூ' },
  '27': { name: 'Maharashtra', name_ta: 'மகாராஷ்டிரா' },
  '29': { name: 'Karnataka', name_ta: 'கர்நாடகா' },
  '30': { name: 'Goa', name_ta: 'கோவா' },
  '31': { name: 'Lakshadweep', name_ta: 'லட்சத்தீவு' },
  '32': { name: 'Kerala', name_ta: 'கேரளா' },
  '33': { name: 'Tamil Nadu', name_ta: 'தமிழ்நாடு' },
  '34': { name: 'Puducherry', name_ta: 'புதுச்சேரி' },
  '35': { name: 'Andaman and Nicobar Islands', name_ta: 'அந்தமான் நிக்கோபார் தீவுகள்' },
  '36': { name: 'Telangana', name_ta: 'தெலங்கானா' },
  '37': { name: 'Andhra Pradesh', name_ta: 'ஆந்திரப் பிரதேசம்' },
  '38': { name: 'Ladakh', name_ta: 'லடாக்' },
  '97': { name: 'Other Territory', name_ta: 'பிற பகுதி' },
  '99': { name: 'Centre Jurisdiction', name_ta: 'மத்திய அரசு வரம்பு' },
};

/** The state's name in a language (Tamil when lang is "ta", else English). GST returns always use English. */
export const stateName = (code: string, lang = 'en') => {
  const s = STATES[code];
  return s ? (lang === 'ta' ? s.name_ta : s.name) : code;
};
