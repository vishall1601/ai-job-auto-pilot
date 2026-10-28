import { GoogleGenAI, Type } from "@google/genai";

const getAI = () => {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

export interface Job {
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  description?: string;
}

export const searchJobs = async (query: string, location: string): Promise<Job[]> => {
  const ai = getAI();
  const prompt = `Find 10 of the latest job openings for "${query}" in "${location}" from portals like LinkedIn, Naukri.com, Indeed, Glassdoor, and Instahyre. 
  Return a list of jobs with their title, company, location, source portal, and direct URL. 
  Ensure the URLs are valid and direct to the job posting.`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            company: { type: Type.STRING },
            location: { type: Type.STRING },
            source: { type: Type.STRING },
            url: { type: Type.STRING },
          },
          required: ["title", "company", "url"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to parse jobs", e);
    return [];
  }
};

export const generateCoverLetter = async (profile: any, job: Job) => {
  const ai = getAI();
  const prompt = `
    User Profile:
    Name: ${profile.name}
    Skills: ${profile.skills}
    Experience: ${profile.experience}
    Resume: ${profile.resume_text}

    Job Details:
    Title: ${job.title}
    Company: ${job.company}
    Description: ${job.description || "N/A"}

    Write a highly professional, tailored cover letter for this job. 
    Mention that the candidate's full resume (PDF) is attached for their review.
    Highlight the user's relevant skills and experience from the resume content provided.
    Keep it concise and impactful.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });

  return response.text;
};
