import os
import json
import re
import asyncio
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from openai import OpenAI
from openai import OpenAI

from bs4 import BeautifulSoup

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class EmailRequest(BaseModel):
    applicantName: str
    targetRole: str
    managerName: str
    targetCompany: str
    personalization: str
    githubUsername: str
    apiKey: str | None = None

class SendEmailRequest(BaseModel):
    to: str
    subject: str
    body: str

async def send_via_smtp(to_email: str, subject: str, text: str):
    """Sends an email using standard SMTP. Requires SMTP_USER and SMTP_PASS env vars."""
    import smtplib
    from email.mime.text import MIMEText
    
    smtp_server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", 587))
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    
    if not smtp_user or not smtp_pass:
        print(f"\n--- MOCK EMAIL SENDING ---")
        print(f"To: {to_email}")
        print(f"Subject: {subject}")
        print(f"Body:\n{text}")
        print(f"--------------------------\n")
        print("Note: Configure SMTP_USER and SMTP_PASS to actually send over the network.")
        return
        
    msg = MIMEText(text)
    msg.add_header("Subject", subject)
    msg.add_header("From", smtp_user)
    msg.add_header("To", to_email)

    with smtplib.SMTP(smtp_server, smtp_port) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.send_message(msg)

async def scrape_website(url: str) -> str:
    """Attempts to scrape text content from a personal website."""
    if not url.startswith("http"):
        url = "https://" + url
    try:
        async with httpx.AsyncClient(timeout=10.0) as http_client:
            res = await http_client.get(url)
            res.raise_for_status()
            soup = BeautifulSoup(res.text, "html.parser")
            
            # Kill script and style elements
            for script in soup(["script", "style"]):
                script.extract()
                
            text = soup.get_text(separator=' ')
            # Clean up whitespace
            lines = (line.strip() for line in text.splitlines())
            chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
            text = '\n'.join(chunk for chunk in chunks if chunk)
            
            # Truncate to avoid massive prompts
            return text[:2000]
    except Exception as e:
        print(f"Failed to scrape {url}: {e}")
        return ""

async def fetch_and_yield_github_summary(username: str):
    """Fetches all public repos and attempts to scrape the personal website."""
    try:
        async with httpx.AsyncClient() as http_client:
            # First, fetch the user profile to get total_public_repos and blog URL
            user_res = await http_client.get(f"https://api.github.com/users/{username}")
            if user_res.status_code == 404:
                 yield {"type": "progress", "message": "GitHub user not found."}
                 yield {"type": "github_result", "data": "The provided GitHub username does not exist.", "website_context": ""}
                 return
            user_res.raise_for_status()
            user_data = user_res.json()
            total_repos = user_data.get("public_repos", 0)
            blog_url = user_data.get("blog", "")
            
            website_context = ""
            if blog_url:
                yield {"type": "progress", "message": f"Found portfolio website: {blog_url}. Analyzing..."}
                website_context = await scrape_website(blog_url)
                if website_context:
                    yield {"type": "progress", "message": f"Successfully analyzed portfolio website."}
            
            if total_repos == 0:
                yield {"type": "progress", "message": "User found, but has 0 public repositories."}
                yield {"type": "github_result", "data": "The applicant has a GitHub account, but no public repositories.", "website_context": website_context, "readme_context": ""}
                return
                
            yield {"type": "progress", "message": f"Found {total_repos} repositories. Scanning...", "total": total_repos, "scanned": 0}

            repos = []
            page = 1
            while True:
                res = await http_client.get(
                    f"https://api.github.com/users/{username}/repos?sort=updated&per_page=100&page={page}"
                )
                res.raise_for_status()
                page_repos = res.json()
                if not page_repos:
                    break
                
                repos.extend(page_repos)
                yield {"type": "progress", "message": f"Scanning...", "total": total_repos, "scanned": len(repos)}
                page += 1
                await asyncio.sleep(0.1) # Small delay to not overwhelm the API rate limits if there are many pages
                
            summary_lines = []
            for repo in repos:
                desc = repo.get("description") or "No description provided."
                lang = repo.get("language") or "Unknown language"
                stars = repo.get("stargazers_count", 0)
                summary_lines.append(f"- {repo['name']} ({lang}, {stars} stars): {desc}")
                
            yield {"type": "github_result", "data": "\n".join(summary_lines), "website_context": website_context}
            return
    except Exception as e:
        print(f"Failed to fetch GitHub data for {username}: {e}")
        yield {"type": "progress", "message": f"Failed to fetch GitHub portfolio: {str(e)}"}
        yield {"type": "github_result", "data": "Failed to fetch GitHub portfolio.", "website_context": ""}
        return

async def fetch_readme_for_url(url: str) -> str:
    """Attempts to fetch the README for a given GitHub repository URL."""
    try:
        # Extract owner/repo from https://github.com/owner/repo or similar
        match = re.search(r'github\.com/([^/]+)/([^/]+)', url)
        if not match:
            return ""
        
        owner, repo = match.groups()
        # Clean up any trailing paths (like /pull/123)
        repo = repo.split('/')[0].split('#')[0]
        
        async with httpx.AsyncClient(timeout=10.0) as http_client:
            res = await http_client.get(
                f"https://api.github.com/repos/{owner}/{repo}/readme",
                headers={"Accept": "application/vnd.github.v3.raw"}
            )
            if res.status_code == 200:
                # Truncate to first 2500 chars to save prompt space
                return res.text[:2500]
            return ""
    except Exception as e:
        print(f"Failed to fetch README for {url}: {e}")
        return ""

def build_prompt(data: EmailRequest, github_context: str = "", website_context: str = "", readme_context: str = "") -> str:
    website_str = f"- Applicant's Personal Website Scraped Text:\n{website_context}" if website_context else "- No personal website detected."
    readme_str = f"- Details about the Applicant's specific contribution/repo:\n{readme_context}" if readme_context else "- No specific repo README provided."
    
    return f"""You are an expert career coach and technical recruiter. Your objective is to write a highly compelling, personalized cold email from a software developer to a hiring manager or engineering lead.
    
    IMPORTANT CONTEXT:
    Do NOT write weak, subservient emails asking "how can I contribute." The applicant is a strong engineer building real systems. The tone must be confident, establishing that the applicant *already* builds impressive things and wants to discuss their work and its relevance to the company.

Here is the specific context for this email:
- Applicant Name: {data.applicantName}
- Target Role: {data.targetRole}
- Hiring Manager Name: {data.managerName}
- Target Company: {data.targetCompany}
- Personalization / Core Contribution: {data.personalization}
- Applicant's Full GitHub Portfolio Summary:
{github_context}
{website_str}
{readme_str}

Strict Rules You Must Follow:
1. Length: Keep the entire email strictly under 100 words. Engineers and managers are busy; be brief.
2. Tone: Confident, peer-to-peer, direct, and professional. You are an engineer talking to an engineer. Do NOT beg or sound subservient. 
3. Banned Words: Under no circumstances use "synergy," "delve," "innovative," "passionate," "detail-oriented," "game-changer," "landscape," "transform," or "contribute".
4. Structure:
   - Open immediately with the Personalization/Contribution Detail. Explain explicitly what the applicant built or achieved based on the README context and GitHub portfolio. Do NOT use filler like "Hope this finds you well".
   - Briefly mention the Target Role you are interested in.
   - Highlight 1 or 2 specific concepts from the GitHub Portfolio or Personal Website context. If a personal website/README is present, praise its design, technical depth, or frontend polish. Focus on the actual technologies or projects built.
   - End with a low-friction Call to Action (CTA) asking to share ideas or compare technical notes, NOT asking "how I can contribute." (e.g., "Would love to chat about how you are scaling X at [Company]." or "Open to comparing notes on building Y.")
5. Formatting: Output ONLY valid JSON of this exact shape and nothing else — no markdown fences, no explanations:
{{
  "subject1": "First subject line option",
  "subject2": "Second subject line option",
  "body": "The full email body here."
}}
"""

@app.post("/api/generate")
async def generate_email(request: EmailRequest):
    async def event_generator():
        try:
            # 1. Fetch README if a github url was provided in personalization
            readme_context = ""
            if "github.com" in request.personalization.lower():
                yield f"data: {json.dumps({'type': 'progress', 'message': 'Fetching specific repository README...'})}\n\n"
                readme_context = await fetch_readme_for_url(request.personalization)
                if readme_context:
                    yield f"data: {json.dumps({'type': 'progress', 'message': 'Successfully analyzed repository README.'})}\n\n"
                    
            # 2. Yield progress while fetching GitHub
            github_context = ""
            website_context = ""
            async for event in fetch_and_yield_github_summary(request.githubUsername):
                if event["type"] == "github_result":
                    github_context = event["data"]
                    website_context = event.get("website_context", "")
                else:
                    yield f"data: {json.dumps(event)}\n\n"

            # 3. Build the final prompt and start LLM generation
            prompt = build_prompt(request, github_context, website_context, readme_context)
            yield f"data: {json.dumps({'type': 'progress', 'message': 'Scan Complete. Generating email via AI...'})}\n\n"
            
            api_key = request.apiKey if request.apiKey else os.environ.get("NVIDIA_API_KEY", "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")
            local_client = OpenAI(
                base_url="https://integrate.api.nvidia.com/v1",
                api_key=api_key
            )
            
            completion = local_client.chat.completions.create(
                model="meta/llama-3.1-70b-instruct",
                messages=[{"role":"user", "content": prompt}],
                temperature=0.6,
                top_p=0.7,
                max_tokens=1024,
                stream=True
            )
            
            final_content = ""
            for chunk in completion:
                if chunk.choices and chunk.choices[0].delta.content is not None:
                    final_content += chunk.choices[0].delta.content
            
            raw_json = final_content.strip()
            raw_json = re.sub(r'^```(?:json)?\s*', '', raw_json, flags=re.IGNORECASE)
            raw_json = re.sub(r'```\s*$', '', raw_json).strip()
            
            if not raw_json:
                raise ValueError("Model returned an empty response. Verify model availability and constraints.")
            try:
                parsed = json.loads(raw_json)
            except Exception as e:
                snippet = final_content[:200]
                raise ValueError(f"JSON Parse Error: {str(e)} | Output prefix: {snippet}")
                
            yield f"data: {json.dumps({'type': 'result', 'data': parsed})}\n\n"
            
        except Exception as e:
            print(f"Error occurred: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/api/send")
async def send_email(request: SendEmailRequest):
    try:
        await send_via_smtp(request.to, request.subject, request.body)
        return {"status": "success", "message": "Email sent successfully!"}
    except Exception as e:
        print(f"Error sending email: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
