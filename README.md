# Masks Off

An in-person social deduction game. Everyone plays on their own phone and the app is the host.
Players only need a phone browser. There are no accounts and nothing to install.

It is one small Node server (no packages to install) plus one web page.

## Run it

You need Node 18 or newer.

**At home, on the same Wi-Fi (simplest)**

1. Put this folder on a laptop and run `node server.js`.
2. Find the laptop's local address (for example `192.168.1.20`).
3. Everyone opens `http://192.168.1.20:3000` on their phone.

**Online (so it works on mobile data too)**

Upload the folder to any host that runs Node and set the start command to `node server.js`.
The server reads the `PORT` environment variable, so most hosts work without changes.
Free tiers often put the app to sleep when idle, so open the page a minute before game night.

**Home-screen icon**

The page ships with a web app manifest and a gold and emerald cloak icon. Once it is online (https), players can add it to their phone:
on iPhone open it in Safari, tap Share, then **Add to Home Screen**. On Android open it in Chrome, tap the
menu, then **Install app** or **Add to Home screen**. It then opens full screen with the Masks Off icon.
(Over plain `http://` on a home network the page works but phones may not offer to install it.)

**Keeping it awake**

Every open phone pings `/healthz` every four minutes, so a free host that sleeps after 15 idle minutes stays awake
during a game. For a long night, a paid always-on plan with a persistent disk (set `DATA_FILE` to a path on the disk)
is the safest choice.

**Refreshing and restarts**

A phone that refreshes, locks its screen or loses signal returns straight to its place in the game.
No sign-in is needed. Each phone remembers its seat in the browser, so clearing the browser's site data
or opening a private tab is the only way to lose it.
The server also saves every game to `games.json` next to `server.js`, so restarting the server does not end a
game in progress. Use the `DATA_FILE` environment variable to put that file somewhere else.
Some free hosts wipe their disk on restart. On those, a restart will still end the game.
A game is only removed after it has ended (and been idle for 30 minutes) or after 6 hours with no activity.

## How a game runs

1. One person taps **Host a game** and shares the four letter code. Everyone else taps **Join**.
   Everyone enters their name and takes a photo of their face (the front camera opens on a phone, or they can choose one from their photo library).
   Names and photos show in the chats, like a messenger app. Photos are small, stay on the server only
   for the length of the game, and are only sent to players in the same game.
2. The host taps **Deal the roles**. Traitors are picked at random from everyone, host included:
   1 to 7 players = 1 Traitor, 8 to 11 = 2, 12 or more = 3.
3. Each player gets somewhere private, taps to see their role, then taps to hide it.
4. **Day.** Talk, and run your missions in person. Before calling the banishment the host can:
   * add the money the group earned in that round's missions to **the pot**, which everyone can see,
   * mark who earned a **shield**, which everyone can see. A shield only protects its holder from
     **murder** that night. Shields do not affect banishment. They clear after the night.
   * start a timer.
   Then the host taps **Call the banishment**.
5. **Banishment.** Everyone votes at once and locks it in. Players then tap in turn to reveal who
   they voted for. Most votes is banished and taps to reveal Faithful or Traitor.
   A tie means a re-vote between the tied players only, and the tied players cannot vote.
   If it is tied again, one of the tied players is chosen at random and banished.
6. **Night.** The host taps **Start the night**. Everyone puts on a mask. Traitors take theirs off
   and choose on their phones. Traitors must all choose the same thing.
   * **Murder:** Traitors put their masks back on, then the sun rises and the victim is named.
     Players holding a shield cannot be chosen.
   * **Death row** (games that began with more than 15 players): on a random night while more than 12
     players are still in (a 50% chance each eligible night, and only once per game), the Traitors choose **4 players** for death
     row instead of murdering. They may pick Traitors, even themselves, to throw suspicion. The table is
     told who is on death row, and no one dies. On the **next** murder the Traitors may only choose from
     the living players on death row (shielded players still cannot be chosen). The row lasts one night, and a game only ever has one death row.
   * **Recruit:** Traitors put their masks back on and one taps the chosen player on the shoulder.
     That player takes their mask off and joins or declines. Everyone is told no one died.
     A recruit who accepts appears in the Traitors chat.
   Recruiting is offered only after a Traitor is banished early (the game began with more than 16
   players and the banishment was one of the first three, that night only), or whenever one Traitor
   is left with more than 7 players alive.
7. **The end.** The game runs until three players are left. From five players on, roles are no
   longer revealed on banishment. A night murder only happens while 5 or more players are alive,
   so the last murder takes five to four.
   The final three choose to end the game or vote once more.
   * All three end it: if a Traitor is among them, the Traitors win, otherwise the Faithful win.
   * Any one of them votes: one player is banished, and if a Traitor is in the final two the
     Traitors win, otherwise the Faithful win.

The game keeps going even if every Traitor has been found. Nights then pass with a short pause and
the table is told no one died, so nobody can tell whether Traitors remain once roles are hidden.
The same happens on a night where every player the Traitors could murder holds a shield.

Optional environment variables: `PORT`, `DATA_FILE`, `MASKSOFF_ROWCHANCE` (death row chance per eligible
night, 0 to 1, default 0.5).

## Things to know

* The host is an ordinary player. The server keeps every secret, so no phone, the host's included,
  receives anything it should not see.
* Turn on **Host voice** on one phone to have it read the host's lines aloud for the whole room.
* The host has fallback buttons for a stuck player (reveal on someone's behalf, close the vote
  early, skip the night, end the game early).
* Money is shown in Australian dollars (A$). Enter it as `250` or `250.50`. There is an undo for the last amount.
* **Chats** (bottom tab, next to Game): the **Table chat** (everyone reads, only the living post), the
  **Traitors chat** (living and banished Traitors read, living Traitors post), and a **Dead chat** that
  only banished and murdered players can see and post in. Living players can tap **New chat** to start a
  direct message or a group with other living players (once the game has started). When someone is banished
  or murdered they are removed from every direct and group chat, and from then on they can only read the table
  chat and post in the dead chat. A banished Traitor can still read the Traitors chat but not post in it.
* Minimum four players, maximum thirty.
