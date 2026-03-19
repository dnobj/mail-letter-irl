# Letter IRL Demo Scenarios

Last updated: March 19, 2026

This document captures the recommended demo scenarios for OpenAI submission videos, manual reviewer walkthroughs, and internal rehearsal. The goal is to show both the practical value of Mail Letter IRL and the specific ways it benefits from ChatGPT prose and image generation.

## Demo goals

- Show required setup: users buy pre-paid letter sends on `letterirl.com` before sending mail
- Show a playful, prose-forward letter flow
- Show a visual, image-forward postcard flow
- Show explicit preview-before-send confirmation
- Show that Mail Letter IRL turns ChatGPT output into real physical mail

## Recommended demo sequence

1. Show `letterirl.com` and pre-purchase letter sends
2. Switch to ChatGPT with Mail Letter IRL selected
3. Run the letter-with-inline-image demo
4. Run the postcard demo
5. End on preview or confirmation state

## Scenario 1: Letter With Inline Image

### Concept

`Apology From a Cat`

This scenario is intentionally cheeky and memorable. It shows ChatGPT generating both the prose and the image, then Mail Letter IRL turning that content into a physical letter with an inline image.

### Why this scenario works

- Demonstrates ChatGPT prose generation clearly
- Demonstrates ChatGPT image generation clearly
- Shows the distinct inline-image letter format
- Makes the final physical letter feel charming and unexpected

### Suggested user prompt

`Create a funny physical letter from a mischievous orange cat apologizing for knocking over a houseplant. Include an image of the cat looking innocent but suspicious. Make the tone overly formal, dramatic, and self-important.`

### Suggested recipient setup

- Recipient: the cat's owner
- Sender: the user or household
- Layout: letter with inline image

### Suggested tone

- Mock-formal
- Absurdly sincere
- Slightly smug

### Example closing

`With restrained regret and continued dignity,`

`Sir Pumpkin of the Living Room`

### Demo beats

1. Ask ChatGPT to write the letter and generate the cat image
2. Confirm the response is routed into the inline-image letter preview flow
3. Show the formatted letter preview and embedded image
4. Emphasize that nothing is mailed yet
5. Optionally show explicit send confirmation

## Scenario 2: Postcard With Edited Travel Photo

### Concept

`Wish You Were Here`

The user uploads a real travel photo, asks ChatGPT to edit it so a friend appears in the scene, and then turns that image into a physical postcard.

### Why this scenario works

- Demonstrates practical image editing, not only image generation
- Uses a real personal photo, which feels authentic
- Makes the postcard format emotionally intuitive
- Shows how Mail Letter IRL can turn a conversation and an image into a meaningful physical keepsake

### Suggested user prompt

`Use this travel photo and edit it to include my friend Alex naturally in the scene, smiling like he was there with us the whole time. Then help me make a postcard to send to him saying we missed him and wish he could have come.`

### Suggested back message

`Alex, we fixed the photo so reality better matches how the trip should have gone. We missed you the whole time and saved you a place in the memories anyway. Hope we do the real version together soon.`

### Demo beats

1. Upload the original travel photo
2. Ask ChatGPT to edit the photo to include the missing friend
3. Use the edited image to create a postcard preview
4. Show both front and back preview
5. Emphasize that the postcard is reviewed before sending

### Mobile note

This scenario is a good candidate for mobile testing because it uses a realistic photo workflow. However, mobile image handoff into apps has been unreliable in prior testing. If the edited image does not flow directly into the postcard tool on mobile, use one of these fallback plans:

- record the postcard segment on desktop instead
- deliberately show the upload fallback path
- use a generated image instead of an uploaded-photo editing flow

## Submission video script outline

### Opening

`Mail Letter IRL lets you use ChatGPT to create and send real physical letters and postcards through USPS. Before sending mail, users first buy pre-paid letter sends on letterirl.com.`

### Letter segment

`Here, I ask ChatGPT to create a funny apology letter from a mischievous cat, complete with a custom image. Mail Letter IRL turns that writing and image into a real letter preview with the image embedded inline. Nothing is mailed yet — I review everything before sending.`

### Postcard segment

`Next, I upload a real travel photo and ask ChatGPT to edit it so a friend who missed the trip appears in the scene. Then Mail Letter IRL turns that edited image into a real postcard preview, with the image on the front and a personal note on the back.`

### Closing

`Mail Letter IRL combines the power of ChatGPT prose and image generation with the charm and impact of real physical mail.`

## Recording checklist

- Confirm the ChatGPT app name and icon are visible
- Confirm pre-purchase setup is shown briefly at the start
- Avoid long typing pauses by preparing the prompts in advance
- Make sure the preview widgets render fully before advancing
- Keep send confirmation explicit and visible
- If mobile image editing fails, switch to desktop or fallback flow instead of forcing a broken take
