"""Generate the Memory setup guide Word document."""

from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.style import WD_STYLE_TYPE
import os

doc = Document()

# ── Styles ──────────────────────────────────────────────────────
style = doc.styles['Normal']
font = style.font
font.name = 'Calibri'
font.size = Pt(11)
font.color.rgb = RGBColor(0x33, 0x33, 0x33)
style.paragraph_format.space_after = Pt(6)
style.paragraph_format.line_spacing = 1.15

for level in range(1, 4):
    h = doc.styles[f'Heading {level}']
    h.font.color.rgb = RGBColor(0x1a, 0x1a, 0x2e)
    h.font.name = 'Calibri'

doc.styles['Heading 1'].font.size = Pt(22)
doc.styles['Heading 2'].font.size = Pt(16)
doc.styles['Heading 3'].font.size = Pt(13)


def add_code(text):
    """Add a code block as a formatted paragraph."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.left_indent = Inches(0.3)
    run = p.add_run(text)
    run.font.name = 'Consolas'
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x1a, 0x1a, 0x2e)
    return p


def add_note(text):
    """Add a tip/note paragraph."""
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.3)
    run = p.add_run(f"Note: {text}")
    run.font.italic = True
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    return p


def add_step(number, text):
    """Add a numbered step with bold number."""
    p = doc.add_paragraph()
    run_num = p.add_run(f"Step {number}: ")
    run_num.bold = True
    p.add_run(text)
    return p


# ── Title Page ──────────────────────────────────────────────────
doc.add_paragraph()
doc.add_paragraph()
title = doc.add_heading('Memory', level=1)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = subtitle.add_run('Give Your AI a Memory That Works Everywhere')
run.font.size = Pt(14)
run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

doc.add_paragraph()
intro = doc.add_paragraph()
intro.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = intro.add_run(
    'A complete, non-technical guide to setting up persistent memory '
    'for your AI assistant. No coding experience required.'
)
run.font.size = Pt(11)
run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)

doc.add_page_break()

# ── What Is This? ──────────────────────────────────────────────
doc.add_heading('What Is This?', level=1)

doc.add_paragraph(
    'Right now, every time you start a new conversation with an AI like Claude, '
    'it forgets everything from the last conversation. It\'s like meeting someone '
    'with amnesia every single day.'
)
doc.add_paragraph(
    'Memory fixes that. It gives your AI a permanent memory bank that it can '
    'save to and search through. It works across all platforms — desktop app, '
    'web, mobile, coding tools — because the memory lives in the cloud, not '
    'on any one device.'
)
doc.add_paragraph(
    'Your AI can store things like "the user prefers dark mode" or '
    '"we decided to use Python for this project" and recall them later, '
    'even in a completely new conversation.'
)

doc.add_heading('What You\'ll Need', level=2)
doc.add_paragraph('1. A computer (Windows, Mac, or Linux)', style='List Number')
doc.add_paragraph('2. An internet connection', style='List Number')
doc.add_paragraph('3. About 20-30 minutes', style='List Number')
doc.add_paragraph('4. A Cloudflare account (free — we\'ll create one)', style='List Number')
doc.add_paragraph('5. Node.js installed (free — we\'ll do this too)', style='List Number')

doc.add_heading('What It\'ll Cost', level=2)
doc.add_paragraph(
    'Nothing. Everything in this guide uses free tiers. Cloudflare\'s free plan '
    'gives you way more than you\'ll ever need for personal use.'
)

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 1
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 1: Install Node.js', level=1)

doc.add_paragraph(
    'Node.js is a program that lets you run JavaScript code on your computer. '
    'We need it to deploy your memory server. You\'ll only need to install it once.'
)

add_step(1, 'Open your web browser and go to:')
p = doc.add_paragraph()
run = p.add_run('https://nodejs.org')
run.font.color.rgb = RGBColor(0x05, 0x63, 0xC1)
run.underline = True

add_step(2, 'Click the big green button that says "LTS" (Long Term Support). '
    'This downloads the installer.')

add_step(3, 'Open the downloaded file and follow the installation wizard. '
    'Click "Next" through everything — the default settings are fine.')

add_step(4, 'To check it worked, open your terminal:')
doc.add_paragraph(
    '    On Windows: Press the Windows key, type "cmd", and press Enter.'
)
doc.add_paragraph(
    '    On Mac: Press Cmd + Space, type "Terminal", and press Enter.'
)

add_step(5, 'Type this and press Enter:')
add_code('node --version')
doc.add_paragraph(
    'You should see a version number like "v22.x.x". If you do, you\'re good.'
)

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 2
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 2: Create a Cloudflare Account', level=1)

doc.add_paragraph(
    'Cloudflare is where your memory server will live. Think of it as renting a tiny, '
    'always-on computer in the cloud that stores and searches your AI\'s memories.'
)

add_step(1, 'Go to:')
p = doc.add_paragraph()
run = p.add_run('https://dash.cloudflare.com/sign-up')
run.font.color.rgb = RGBColor(0x05, 0x63, 0xC1)
run.underline = True

add_step(2, 'Create an account with your email and a password.')
add_step(3, 'Check your email and click the verification link.')
add_step(4, 'You\'ll land on the Cloudflare dashboard. That\'s all we need for now.')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 3
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 3: Download the Memory Project', level=1)

add_step(1, 'Open your terminal (same as Part 1, Step 4).')

add_step(2, 'Choose where you want to put the project. For example, to put it '
    'on your Desktop, type:')
add_code('cd Desktop')

add_step(3, 'Download the project by typing:')
add_code('git clone https://github.com/YOUR-USERNAME/memory.git')

add_note(
    'If you get an error saying "git is not recognized", you need to install Git first. '
    'Go to https://git-scm.com/downloads, install it, then close and reopen your terminal.'
)

add_step(4, 'Go into the project folder:')
add_code('cd Memory')

add_step(5, 'Install the project\'s dependencies (the libraries it needs to work):')
add_code('npm install')
doc.add_paragraph('This might take a minute. Wait until it finishes.')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 4
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 4: Connect to Cloudflare', level=1)

doc.add_paragraph(
    'Now we need to link this project to your Cloudflare account.'
)

add_step(1, 'In your terminal (still inside the Memory folder), type:')
add_code('npx wrangler login')

doc.add_paragraph(
    'This will open your web browser. Click "Allow" to give Wrangler '
    '(the Cloudflare deployment tool) access to your account.'
)

add_step(2, 'Once you see "Successfully logged in" in the terminal, you\'re connected.')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 5
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 5: Create the Database', level=1)

doc.add_paragraph(
    'Your AI\'s memories need somewhere to be stored. We\'re going to create '
    'a database (think of it as a spreadsheet in the cloud).'
)

add_step(1, 'In your terminal, type:')
add_code('npx wrangler d1 create memory-db')

doc.add_paragraph(
    'You\'ll see output that includes something like:'
)
add_code('database_id = "abc123-something-long-here"')

add_step(2, 'Copy that entire database_id value (the part in quotes).')

add_step(3, 'Now you need to edit a file. Open the project folder in File Explorer '
    '(or Finder on Mac) and find the file called wrangler.toml. '
    'Open it with any text editor (Notepad works fine).')

add_step(4, 'Find this line near the bottom:')
add_code('database_id = "YOUR_DATABASE_ID"')

add_step(5, 'Replace YOUR_DATABASE_ID with the ID you copied. For example:')
add_code('database_id = "abc123-something-long-here"')

add_step(6, 'Save and close the file.')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 6
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 6: Create the Search Index', level=1)

doc.add_paragraph(
    'This is what lets your AI search memories by meaning instead of just exact words. '
    'For example, searching for "favourite food" can find a memory that says "I love pizza".'
)

add_step(1, 'In your terminal, type:')
add_code('npx wrangler vectorize create memory-index --dimensions=768 --metric=cosine')

add_note(
    'If you get an error about the index already existing, that\'s fine — just move on.'
)

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 7
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 7: Set Up the Database Tables', level=1)

doc.add_paragraph(
    'Now we need to set up the structure inside the database (like creating the columns '
    'in that spreadsheet).'
)

add_step(1, 'In your terminal, type:')
add_code('npx wrangler d1 execute memory-db --remote --file=schema.sql')

doc.add_paragraph(
    'If this doesn\'t give any errors, your database is ready.'
)

add_note(
    'If you get an authentication error with this command, try this alternative instead:\n'
    'npx wrangler d1 execute memory-db --remote --command="CREATE TABLE IF NOT EXISTS memories '
    '(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT NOT NULL DEFAULT '
    '\'general\', tags TEXT DEFAULT \'[]\', source TEXT DEFAULT \'unknown\', created_at TEXT NOT NULL '
    'DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')));"'
)

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 8
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 8: Set a Password (Recommended)', level=1)

doc.add_paragraph(
    'This protects your memory server so only you (and your AI) can access it.'
)

add_step(1, 'In your terminal, type:')
add_code('npx wrangler secret put MEMORY_SECRET')

add_step(2, 'It will ask you to type a secret value. Type any password you want and press Enter. '
    'It won\'t show what you\'re typing — that\'s normal, it\'s hidden for security.')

p = doc.add_paragraph()
run = p.add_run('Write this password down somewhere safe. You\'ll need it in the next part.')
run.bold = True

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 9
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 9: Deploy!', level=1)

doc.add_paragraph('This is the exciting bit. You\'re about to put your memory server live.')

add_step(1, 'In your terminal, type:')
add_code('npm run deploy')

doc.add_paragraph(
    'When it finishes, you\'ll see a URL that looks something like:'
)
add_code('https://memory-server.your-name.workers.dev')

p = doc.add_paragraph()
run = p.add_run('Copy this URL and save it. This is your memory server\'s address.')
run.bold = True

add_step(2, 'To test it, open that URL in your browser. You should see:')
add_code('{"status":"ok","name":"Memory","version":"1.0.0"}')

doc.add_paragraph('If you see that, everything is working. Your memory server is live.')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# PART 10
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Part 10: Connect It to Your AI', level=1)

doc.add_paragraph(
    'Now for the final piece — telling your AI where its memory lives. '
    'Follow the section below that matches how you use your AI.'
)

# ── Claude Desktop ────────────────────────────────────────────
doc.add_heading('Option A: Claude Desktop App', level=2)

add_step(1, 'Open Claude Desktop.')
add_step(2, 'Click on the Claude menu (top-left on Mac, or the hamburger menu).')
add_step(3, 'Go to Settings, then Developer, then "Edit Config".')
add_step(4, 'This opens a file. Replace its contents with the following '
    '(or add the "memory" section if you already have other servers configured):')

add_code(
    '{\n'
    '  "mcpServers": {\n'
    '    "memory": {\n'
    '      "url": "https://memory-server.YOUR-SUBDOMAIN.workers.dev/sse?secret=YOUR_PASSWORD"\n'
    '    }\n'
    '  }\n'
    '}'
)

add_step(5, 'Replace YOUR-SUBDOMAIN with your actual Cloudflare subdomain '
    '(from the URL you got in Part 9).')
add_step(6, 'Replace YOUR_PASSWORD with the password you created in Part 8.')
add_step(7, 'Save the file and restart Claude Desktop.')

doc.add_paragraph(
    'You should now see a hammer/tools icon in the chat input area. '
    'That means Memory is connected!'
)

# ── Claude Code ───────────────────────────────────────────────
doc.add_heading('Option B: Claude Code (Terminal)', level=2)

add_step(1, 'Open your terminal and type:')
add_code(
    'claude mcp add memory --transport sse '
    '"https://memory-server.YOUR-SUBDOMAIN.workers.dev/sse?secret=YOUR_PASSWORD"'
)
add_step(2, 'Replace YOUR-SUBDOMAIN and YOUR_PASSWORD as described above.')
doc.add_paragraph('That\'s it. Claude Code will now have access to your memory tools.')

# ── Other MCP Clients ────────────────────────────────────────
doc.add_heading('Option C: Other AI Apps That Support MCP', level=2)

doc.add_paragraph(
    'Any app that supports the Model Context Protocol can connect. You\'ll need to provide:'
)
doc.add_paragraph('URL:  https://memory-server.YOUR-SUBDOMAIN.workers.dev/sse')
doc.add_paragraph('Authentication:  Add ?secret=YOUR_PASSWORD to the URL, or set an '
    'Authorization header with the value "Bearer YOUR_PASSWORD".')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# USING IT
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Using Your Memory', level=1)

doc.add_paragraph(
    'Once connected, your AI will have new tools available. You can ask it things like:'
)

examples = [
    '"Remember that I prefer Python over JavaScript."',
    '"What do you remember about my project preferences?"',
    '"Save this: my dog\'s name is Max and he\'s a golden retriever."',
    '"What have you stored about me so far?"',
    '"Forget memory number 5."',
]
for ex in examples:
    p = doc.add_paragraph(style='List Bullet')
    run = p.add_run(ex)
    run.font.italic = True

doc.add_paragraph()
doc.add_paragraph(
    'The AI will automatically use the right memory tool based on what you ask. '
    'You don\'t need to use any special commands.'
)

doc.add_heading('Tips', level=2)

tips = [
    'Your AI won\'t automatically save everything — tell it when you want something '
    'remembered. Over time, you can also instruct it to proactively store things.',
    'Memories work across platforms. Save something in the desktop app, recall it '
    'on mobile.',
    'Use tags to organize. Say "remember this and tag it as work" to make things '
    'easier to find later.',
    'You can ask for stats: "How many memories do you have stored?" gives you a '
    'breakdown.',
]
for tip in tips:
    doc.add_paragraph(tip, style='List Bullet')

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# TROUBLESHOOTING
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Troubleshooting', level=1)

problems = [
    (
        '"npm" or "node" is not recognized',
        'Node.js isn\'t installed properly, or your terminal needs to be restarted. '
        'Close the terminal, reopen it, and try again. If it still doesn\'t work, '
        'reinstall Node.js from https://nodejs.org.'
    ),
    (
        '"git" is not recognized',
        'You need to install Git. Go to https://git-scm.com/downloads, install it, '
        'then close and reopen your terminal.'
    ),
    (
        'Wrangler login opens the browser but nothing happens',
        'Make sure you\'re logged into your Cloudflare account in that browser. '
        'Try a different browser if it\'s still stuck.'
    ),
    (
        'Deploy fails with an error',
        'Make sure you\'ve replaced YOUR_DATABASE_ID in wrangler.toml with your '
        'actual database ID from Part 5. The ID should be inside the quotes.'
    ),
    (
        'Claude doesn\'t show the memory tools',
        'Double-check the URL in your config file. Make sure there are no extra spaces, '
        'and that you\'ve replaced both YOUR-SUBDOMAIN and YOUR_PASSWORD. '
        'Restart Claude Desktop after changing the config.'
    ),
    (
        'Getting "Unauthorized" errors',
        'The password in your config URL doesn\'t match the MEMORY_SECRET you set. '
        'You can reset it by running: npx wrangler secret put MEMORY_SECRET '
        '(from inside the Memory project folder).'
    ),
]

for problem, solution in problems:
    p = doc.add_paragraph()
    run = p.add_run(f'"{problem}"')
    run.bold = True
    doc.add_paragraph(solution)

doc.add_page_break()

# ═══════════════════════════════════════════════════════════════
# FAQ
# ═══════════════════════════════════════════════════════════════
doc.add_heading('Frequently Asked Questions', level=1)

faqs = [
    (
        'Is this free?',
        'Yes. Everything uses Cloudflare\'s free tier, which is more than enough for '
        'personal use. You\'d need thousands of memories stored and searched per day '
        'to even come close to the limits.'
    ),
    (
        'Is my data safe?',
        'Your memories are stored in your own Cloudflare account. Nobody else has access. '
        'The password you set prevents unauthorized access to your memory server.'
    ),
    (
        'Can I delete all my memories and start fresh?',
        'Yes. You can either ask your AI to forget individual memories, or you can '
        'delete the entire database from your Cloudflare dashboard and recreate it '
        'by running Parts 5 and 7 again.'
    ),
    (
        'Does this work with ChatGPT / Gemini / other AIs?',
        'It works with any AI application that supports the Model Context Protocol (MCP). '
        'Currently, Claude is the main AI with full MCP support. As more AIs adopt MCP, '
        'they\'ll be able to use this too — with no changes needed on your end.'
    ),
    (
        'Can I move this to a different computer?',
        'Your memory server runs in the cloud, so you don\'t need to move anything. '
        'Just set up the connection on your new device (Part 10) and you\'re good. '
        'Your memories are already there.'
    ),
    (
        'What happens if Cloudflare goes down?',
        'Cloudflare is one of the largest infrastructure companies in the world. '
        'Downtime is extremely rare. If it does happen, your memories aren\'t lost — '
        'they\'ll be available again as soon as the service recovers.'
    ),
]

for question, answer in faqs:
    p = doc.add_paragraph()
    run = p.add_run(question)
    run.bold = True
    doc.add_paragraph(answer)

# ── Footer ────────────────────────────────────────────────────
doc.add_paragraph()
doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('Made with create-memory-server')
run.font.size = Pt(9)
run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('https://github.com/YOUR-USERNAME/memory')
run.font.size = Pt(9)
run.font.color.rgb = RGBColor(0x05, 0x63, 0xC1)

# ── Save ──────────────────────────────────────────────────────
output_path = os.path.expanduser('~/Desktop/Memory Setup Guide.docx')
doc.save(output_path)
print(f'Saved to: {output_path}')
