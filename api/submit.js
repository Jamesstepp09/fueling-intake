import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const intake = req.body;
  const athleteName = `${intake.first_name || ''} ${intake.last_name || ''}`.trim();
  const athleteEmail = intake.email;

  // ── STEP 1: Save to Supabase ──────────────────────────────────────────
  let submissionId = null;
  try {
    const { data, error } = await supabase
      .from('submissions')
      .insert({
        intake_json: intake,
        athlete_name: athleteName,
        athlete_email: athleteEmail,
        sport: intake.sport || '',
        status: 'pending'
      })
      .select()
      .single();

    if (error) console.error('Supabase insert error:', error);
    else submissionId = data.id;
  } catch (err) {
    console.error('Supabase error:', err);
  }

  // ── STEP 2: Send confirmation to athlete immediately ──────────────────
  try {
    await sendEmail({
      to: athleteEmail,
      toName: athleteName,
      subject: `We received your intake — ${athleteName}`,
      text: `Hi ${intake.first_name},\n\nYour performance fueling plan intake has been received. Your plan will be delivered to this email within 24 hours.\n\nIf you have any questions, reply to this email.\n\nFueling Plans`,
      html: confirmationHTML(intake.first_name, athleteName)
    });
  } catch (err) {
    console.error('Confirmation email error:', err);
  }

  // ── STEP 3: Notify admin (James) of new submission ────────────────────
  try {
    await sendEmail({
      to: 'jamesstepp09@icloud.com',
      toName: 'James Stepp',
      subject: `New intake submission — ${athleteName} (${intake.sport || 'sport unknown'})`,
      text: `New submission received.\n\nAthlete: ${athleteName}\nEmail: ${athleteEmail}\nSport: ${intake.sport || 'not provided'}\nGoal: ${intake.primary_goal || 'not provided'}\nSeason: ${intake.season_phase || 'not provided'}\n\nFull intake data:\n\n${JSON.stringify(intake, null, 2)}`,
      html: adminNotificationHTML(intake, athleteName, submissionId)
    });
  } catch (err) {
    console.error('Admin notification error:', err);
  }

  // Return 200 immediately — athlete has their confirmation
  res.status(200).json({ success: true });

  // ── STEP 4: Generate plan with Claude ─────────────────────────────────
  // This runs after the response is sent
  // Vercel will keep the function alive briefly to complete this
  try {
    const plan = await generatePlan(intake);

    // ── STEP 5: Send plan to athlete ──────────────────────────────────────
    await sendEmail({
      to: athleteEmail,
      toName: athleteName,
      subject: `Your Performance Fueling Plan — ${athleteName}`,
      text: plan,
      html: planHTML(plan, athleteName)
    });

    // ── STEP 6: Send plan to admin ────────────────────────────────────────
    await sendEmail({
      to: 'jamesstepp09@icloud.com',
      toName: 'James Stepp',
      subject: `Plan delivered — ${athleteName}`,
      text: plan,
      html: planHTML(plan, athleteName)
    });

    // ── STEP 7: Update Supabase status ─────────────────────────────────────
    if (submissionId) {
      await supabase
        .from('submissions')
        .update({ status: 'completed' })
        .eq('id', submissionId);
    }

  } catch (err) {
    console.error('Plan generation error:', err);

    // Alert admin that manual fulfillment is needed
    try {
      await sendEmail({
        to: 'jamesstepp09@icloud.com',
        toName: 'James Stepp',
        subject: `ACTION REQUIRED — Plan generation failed for ${athleteName}`,
        text: `Plan generation failed for ${athleteName} (${athleteEmail}).\n\nManual fulfillment required.\n\nError: ${err.message}\n\nIntake data:\n\n${JSON.stringify(intake, null, 2)}`,
        html: `<p>Plan generation failed for <strong>${athleteName}</strong> (${athleteEmail}).</p><p>Manual fulfillment required.</p><p>Error: ${err.message}</p><pre style="background:#f5f5f5;padding:16px;font-size:12px">${JSON.stringify(intake, null, 2)}</pre>`
      });
    } catch (e) {
      console.error('Failed to send failure alert:', e);
    }

    if (submissionId) {
      await supabase
        .from('submissions')
        .update({ status: 'failed' })
        .eq('id', submissionId);
    }
  }
}

// ── CLAUDE PLAN GENERATOR ───────────────────────────────────────────────
async function generatePlan(intake) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: buildSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: `Generate a complete personalized performance nutrition plan for this athlete. Use their actual name, sport, position, and all schedule details throughout. Calculate their BMR using the Harris-Benedict formula with their exact numbers and show your work.\n\nATHLETE INTAKE DATA:\n${JSON.stringify(intake, null, 2)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

function buildSystemPrompt() {
  return `You are an elite sports dietitian with a CSSD (Certified Specialist in Sports Dietetics) credential. You are generating a personalized performance nutrition plan that will be delivered directly to an athlete. This is a premium $99 product — the plan should be comprehensive, specific, and feel like it was written by a human expert who spent hours on it.

VOICE AND TONE
- Address the athlete directly using "you" and "your" throughout
- Be direct, confident, and specific — never use hedging language for evidence-based recommendations
- Sound like a knowledgeable coach and scientist combined, not a wellness app
- Reference the athlete's specific sport, position, club, and schedule details throughout
- Every recommendation should feel tailored to THIS athlete, not copy-pasted from a template

OUTPUT STRUCTURE
Generate the plan using these exact sections with these exact headers:

# [ATHLETE FIRST NAME LAST NAME]
## [Sport] · [Position/Role/Event] · [Club/Team if provided] · [Season Phase]

---

### ATHLETE SNAPSHOT
A formatted stat block with these exact fields:
Age | Height | Weight | BMR | Training Day Target | Rest Day Target | Daily Protein | Season Phase | Primary Goal

---

### THE SCIENCE BEHIND YOUR NUMBERS
Show the complete Harris-Benedict calculation with the athlete's actual numbers:
- Male: 88.362 + (13.397 × weight_kg) + (4.799 × height_cm) - (5.677 × age)
- Female: 447.593 + (9.247 × weight_kg) + (3.098 × height_cm) - (4.330 × age)
- If "Prefer not to say": average of both formulas
Convert their height (feet/inches) to cm and weight (lbs) to kg before calculating. Show the conversion.
Explain their sport-specific activity multiplier and why it applies to their position specifically.
If they provided wearable active calorie data, note that those numbers override the formula estimate and explain why measured data is more accurate.
2-3 paragraphs total. Make it feel like genuine science, not filler.

---

### MACRONUTRIENT TARGETS
A table with columns: Day Type | Calories | Protein | Carbohydrates | Fat | Hydration
Rows for: Training Day, Rest Day, and any applicable variants (Lift Day, Game Day, Two-a-Day)
Below the table: Key food sources for each macronutrient.

---

### DAILY FUELING SCHEDULE — TRAINING DAY
Place EVERY meal and snack at an exact clock time based on their schedule inputs.
Format each entry as:
**[EXACT TIME] — [MEAL NAME]**
~[calories] kcal · [protein]g protein · [carbs]g carbs · [fat]g fat
- [Specific food item with portion]
- [Specific food item with portion]
- [etc.]
*Why this meal at this time: [1-2 sentence explanation tied to their specific training window]*

If they reported food access constraints (dining hall, dorm, family prepares meals), all food options must work within those constraints.
If they reported food restrictions or allergies, never suggest those foods.

---

### DAILY FUELING SCHEDULE — REST DAY
Same format but calibrated to rest day targets. Explain the key differences from training day.

---

### LIFT DAY ADJUSTMENTS
Only include this section if does_lift is true.
What specifically changes on lift days — additional calories, protein timing around the lift, post-lift recovery window, creatine timing.

---

### GAME DAY PROTOCOL
Only include if has_game_days is true.
Build the entire timeline around their reported game_time:
- Morning game (before 11am): different pre-game meal timing than evening
- Evening game (after 5pm): longer fueling runway
Include: waking nutrition, pre-game meal (3-4 hours out), 60-90 min pre-game snack, warm-up window, halftime or mid-competition fueling, immediate post-game recovery, post-game meal.

---

### HYDRATION PROTOCOL
A table showing fluid targets by time of day.
Calibrate to their training environment — if outdoor training is involved, increase targets significantly for heat.
If they reported cramping or poor hydration habits, address that directly.
Include electrolyte guidance.

---

### SUPPLEMENT STACK
For each recommended supplement, use this format:
**[SUPPLEMENT NAME]** — [EVIDENCE GRADE: STRONG / GOOD / SITUATIONAL]
Dose: [specific dose and form]
Timing: [exact timing tied to their schedule]
Why for you: [reason specific to their sport, position, and training load — not generic]

Rules:
- Never recommend a supplement they're already taking (check their sups array)
- If drug_tested is true, every recommendation must note NSF Certified for Sport or Informed Sport requirement
- Calibrate to their supplement_budget
- Only include supplements with genuine evidence for their specific situation

---

### RECOVERY AND SLEEP NUTRITION
Tie recommendations directly to their reported sleep_hours and sleep_quality.
Pre-sleep protein timing. Overnight muscle protein synthesis window.
If injuryStatusSeverity is not "No injury": collagen + vitamin C timing 45-60 minutes before training or PT, anti-inflammatory food emphasis, adjusted protein target.

---

### CYCLE PROTOCOL
ONLY include this section if sex is "Female" AND cycle_affects_training is "Yes".
Header: ### CYCLE-INFORMED NUTRITION PROTOCOL
Standing monthly protocol for the 5-7 days before menstruation:
- Iron-rich foods and vitamin C pairing (explain absorption mechanism)
- Slightly elevated calorie expectations during luteal phase
- Performance expectation management
- Specific foods and timing
End with: "If your cycle is irregular or has changed since increasing training load, a gynecologist or sports medicine physician is the right first call."

---

### INJURY AND RECOVERY NUTRITION
ONLY include if injuryStatusSeverity is NOT "No injury".
Collagen peptides + vitamin C timing (45-60 min before loading/PT), anti-inflammatory food protocol, adjusted protein targets, specific foods for connective tissue support.
End with: "These recommendations support recovery but do not replace the guidance of your physical therapist or physician."

---

### WEEKLY OVERVIEW
A clean Mon-Sun table. Columns: Day | Type | Calories | Protein | Carbs | Creatine | Collagen | Notes
Make it scannable — this is the page they'll reference daily.

---

### IMPORTANT NOTICE
Standard disclaimer: AI-generated evidence-based framework, not a substitute for individualized medical or dietetic advice. Recommend consultation with CSSD dietitian and physician before implementing supplement protocols. Key sources used (ISSN, ACSM, AAP, Dietary Guidelines).

---

CALCULATION REFERENCE
Activity multipliers (multiply BMR for training day TDEE):
- Soccer CDM/CM/forward: 1.75-1.85 (high aerobic + sprint demands)
- Basketball: 1.7-1.8
- Baseball/softball: 1.5-1.65 (skill sport, lower aerobic)
- Powerlifting: 1.55-1.7
- Bodybuilding: 1.5-1.65
- MMA/wrestling: 1.7-1.85
- Running (recreational-moderate): 1.65-1.75
- Running (high volume): 1.8-2.0
- Triathlon: 1.85-2.1
- Swimming: 1.75-1.9
- Generic team sport: 1.7

Protein targets:
- Standard high-volume training: 1.6-1.8g/kg
- Active injury recovery: 2.0-2.2g/kg
- Two-a-days: 2.0-2.2g/kg
- Combat weight cut: 2.3-2.5g/kg (muscle preservation priority)

Carbohydrate targets:
- Team sport training day: 5-7g/kg
- Team sport rest day: 3-4g/kg
- Endurance high volume: 7-10g/kg
- Strength sport: 3-5g/kg`;
}

// ── EMAIL HELPERS ────────────────────────────────────────────────────────
async function sendEmail({ to, toName, subject, text, html }) {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: toName }], subject }],
      from: { email: 'jamesstepp09@icloud.com', name: 'Fueling Plans' },
      reply_to: { email: 'jamesstepp09@icloud.com' },
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`SendGrid error (${response.status}): ${err}`);
  }
}

function confirmationHTML(firstName, athleteName) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="max-width:600px;margin:0 auto;padding:40px 24px;background:#ffffff;font-family:Arial,sans-serif">
  <div style="background:#0d0d0d;padding:24px 32px;margin-bottom:32px">
    <div style="color:#D4962A;font-size:10px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:8px">Performance Nutrition</div>
    <div style="color:#f0ede6;font-size:20px;font-weight:700">Intake received.</div>
  </div>
  <p style="font-size:16px;color:#333;line-height:1.6">Hi ${firstName},</p>
  <p style="font-size:16px;color:#333;line-height:1.6">Your performance fueling plan intake has been received. Your personalized plan will be delivered to this email within <strong>24 hours</strong>.</p>
  <p style="font-size:16px;color:#333;line-height:1.6">If anything in your intake needs to be changed or you have questions before your plan arrives, reply to this email.</p>
  <p style="font-size:16px;color:#333;line-height:1.6">One revision is included within 14 days of delivery.</p>
  <div style="margin-top:40px;padding-top:20px;border-top:1px solid #eee;font-size:12px;color:#999">
    Fueling Plans · Reply to this email with any questions
  </div>
</body></html>`;
}

function adminNotificationHTML(intake, athleteName, submissionId) {
  const fields = [
    ['Name', athleteName],
    ['Email', intake.email],
    ['Sport', intake.sport || '—'],
    ['Position', intake.position || '—'],
    ['Goal', intake.primary_goal || '—'],
    ['Season', intake.season_phase || '—'],
    ['Sport Type', intake.sport_type || '—'],
    ['Student Status', intake.student_status || '—'],
    ['Submission ID', submissionId || 'pending'],
  ];

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="max-width:680px;margin:0 auto;padding:40px 24px;background:#ffffff;font-family:Arial,sans-serif">
  <div style="background:#0d0d0d;padding:20px 28px;margin-bottom:28px">
    <div style="color:#D4962A;font-size:10px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:6px">New Submission</div>
    <div style="color:#f0ede6;font-size:20px;font-weight:700">${athleteName}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:28px">
    ${fields.map(([k, v]) => `<tr><td style="padding:10px 14px;background:#f8f8f8;font-weight:600;font-size:13px;width:40%;border-bottom:1px solid #eee">${k}</td><td style="padding:10px 14px;font-size:13px;border-bottom:1px solid #eee">${v}</td></tr>`).join('')}
  </table>
  <details>
    <summary style="cursor:pointer;font-size:13px;color:#888;margin-bottom:12px">View full intake JSON</summary>
    <pre style="background:#f5f5f5;padding:16px;font-size:11px;overflow:auto;border-radius:4px">${JSON.stringify(intake, null, 2)}</pre>
  </details>
</body></html>`;
}

function planHTML(plan, athleteName) {
  // Convert markdown headings and bold to HTML
  let html = plan
    .replace(/^# (.+)$/gm, '<h1 style="color:#D4962A;font-family:Arial,sans-serif;font-size:24px;border-bottom:2px solid #D4962A;padding-bottom:10px;margin-top:32px">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#555;font-family:Arial,sans-serif;font-size:16px;margin-top:4px">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#D4962A;font-family:Arial,sans-serif;font-size:16px;margin-top:28px;border-left:3px solid #D4962A;padding-left:12px">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #eee;margin:24px 0">')
    .replace(/^- (.+)$/gm, '<li style="margin-bottom:5px;color:#333">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li style="margin-bottom:5px;color:#333">$2</li>')
    .replace(/\n\n/g, '</p><p style="margin:0 0 12px 0">');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="max-width:680px;margin:0 auto;padding:40px 24px;background:#ffffff">
  <div style="background:#0d0d0d;padding:28px 36px;margin-bottom:40px">
    <div style="color:#D4962A;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:10px">Performance Fueling Plan</div>
    <div style="color:#f0ede6;font-size:26px;font-weight:700;line-height:1.2">${athleteName}</div>
  </div>
  <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333">
    <p style="margin:0 0 12px 0">${html}</p>
  </div>
  <div style="margin-top:48px;padding:20px 24px;background:#f8f8f8;border-left:3px solid #D4962A">
    <p style="font-size:12px;color:#777;line-height:1.6;margin:0">This performance fueling plan is an AI-generated evidence-based framework based on published guidelines from ISSN, ACSM, and AAP. It is not a substitute for individualized medical or dietetic advice. For questions or your included revision, reply to this email within 14 days.</p>
  </div>
</body></html>`;
}
