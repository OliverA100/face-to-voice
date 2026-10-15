/**
 * A character's profile as the browser sees it (written on the server: lib/server/profileSchema.ts and
 * characterProfile.ts). Types only, so nothing here adds to the page's JavaScript.
 */
export interface CharacterProfile {
  name: string;
  title?: string; // a game-style title under the name ("retired chip-shop king"); missing on a profile this tab kept from before it
  backstory: string;
  traits: string[];
  habits: string[];
  quirks: string[];
  interests: string[];
  dislikes: string[]; // things they can't stand (never groups of people)
  pace: string; // how fast they talk (the casting's pacing list)
  vocabulary: string; // the kind of words they use
  catchphrases: string[];
  mood: string; // their mood right now (the casting's mood list)
  greeting: string; // the first thing they say when a conversation starts
  want?: string; // what they are after right now: a hook they bring up in a chat; missing as `title` can be
}

export interface ProfileResult {
  profile: CharacterProfile;
  own: boolean; // this visitor's own version ("Recast"), not the shared one
}
