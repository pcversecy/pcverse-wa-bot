# Pcverse WhatsApp Bot — Φάση 3 (Webhook)

Αυτό το webhook λαμβάνει εισερχόμενα WhatsApp μηνύματα και απαντάει δοκιμαστικά.
Το AI (Claude) προστίθεται στη Φάση 4.

## 1. Φτιάξε το repo στο GitHub
- Φτιάξε ένα **νέο, κενό repo** (π.χ. `pcverse-wa-bot`).
- Ανέβασε όλα αυτά τα αρχεία (κράτα την ίδια δομή φακέλων).

## 2. Σύνδεσέ το στο Netlify
- Netlify → Add new site → Import from GitHub → διάλεξε το repo.
- Build command: (άφησέ το κενό)
- Publish directory: `public`
- Deploy.

Μετά το deploy, το webhook σου θα είναι στο:
```
https://ΤΟ-ΟΝΟΜΑ-ΣΟΥ.netlify.app/.netlify/functions/whatsapp
```

## 3. Βάλε τα Environment Variables στο Netlify
Netlify → Site settings → Environment variables → Add. Πρόσθεσε 3:

| Key | Τιμή |
|-----|------|
| `WHATSAPP_TOKEN` | το μόνιμο token (System User) που έβγαλες |
| `PHONE_NUMBER_ID` | το Phone number ID από το API Setup |
| `VERIFY_TOKEN` | μια **δική σου** τυχαία λέξη, π.χ. `pcverse123secret` |

Μετά πάτα **Trigger deploy** για να τα διαβάσει.

## 4. Σύνδεσε το webhook στη Meta
Στο API Setup → **Step 3: Configure webhooks** → Configure webhooks (ή Edit):
- **Callback URL:** το URL του βήματος 2 (`.../.netlify/functions/whatsapp`)
- **Verify token:** ΑΚΡΙΒΩΣ η ίδια λέξη που έβαλες στο `VERIFY_TOKEN`
- Πάτα **Verify and save** → αν είναι σωστά, θα γίνει πράσινο.
- Μετά στο **Webhook fields**, κάνε **Subscribe** στο πεδίο **`messages`**.

## 5. Δοκιμή
Από το **δικό σου** κινητό, στείλε ένα WhatsApp μήνυμα **στον test αριθμό** της Meta.
Αν όλα δουλεύουν, θα λάβεις πίσω: `Έλαβα το μήνυμά σου: "..." 👍`

Αν δεν λάβεις τίποτα, δες στο Netlify → Functions → `whatsapp` → τα logs.
# pcverse-wa-bot
