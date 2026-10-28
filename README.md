# रावटे परिवार — वंश वृक्ष

परिवार के सदस्य मिलकर वंश वृक्ष भरते हैं। जानकारी Google Sheet में जमा होती है, और एक ही व्यक्ति के बार-बार दर्ज होने पर उसे पहचानकर उसी वंश में जोड़ा जाता है।

## फाइलें

| फाइल | काम |
| --- | --- |
| `index.html` | फॉर्म, वंश वृक्ष देखना, "+ नाम जोड़ें" |
| `Code.gs` | Google Sheet में सेव करना, नाम मिलान, डुप्लिकेट जाँच और मर्ज |

## सेटअप

1. Google Sheet बनाएँ, फिर **Extensions → Apps Script** खोलें।
2. `Code.gs` की सामग्री पेस्ट करें। **+ → HTML** से `Index` नाम की फाइल बनाकर `index.html` की सामग्री पेस्ट करें।
3. `setup` फंक्शन चलाएँ।
4. **Deploy → New deployment → Web app** चुनें। Execute as: **Me**, Who has access: **Anyone**।
5. मिला हुआ `/exec` लिंक परिवार को भेजें।

### GitHub Pages से चलाने के लिए

`index.html` में `SCRIPT_URL` की जगह अपना `/exec` लिंक डालें:

```js
const SCRIPT_URL = 'https://script.google.com/macros/s/……/exec';
```

फिर **Settings → Pages → Branch: main** चुनें।
