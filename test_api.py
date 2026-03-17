import asyncio
import httpx

async def main():
    async with httpx.AsyncClient() as client:
        try:
            async with client.stream("POST", "http://127.0.0.1:8000/api/generate", json={"applicantName":"Aditya","targetRole":"Web Developer","managerName":"Tirth Patel","targetCompany":"MotiChor","personalization":"https://github.com/theallmyti/theallmyti","githubUsername":"theallmyti"}) as r:
                async for chunk in r.aiter_text():
                    print(chunk)
        except Exception as e:
            print(f"FAILED: {e}")

asyncio.run(main())
