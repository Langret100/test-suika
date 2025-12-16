// CPU Controller for MergeGame
// - 제거 시 같이 지울 요소: main.js의 CPU 모드 버튼/표기

function randRange(a,b){ return a + Math.random()*(b-a); }

export class CpuController {
  constructor(game){
    this.game = game;
    this.t = 0;
    this.nextIn = randRange(650, 1200);
  }

  update(dt){
    if(!this.game || this.game.dead) return;
    this.t += dt;
    if(this.t < this.nextIn) return;

    this.t = 0;
    this.nextIn = randRange(550, 1050);

    // pick random x and drop
    const w = this.game.width || (this.game.cv?.width || 360);
    const x = randRange(w*0.12, w*0.88);
    this.game.dropX = x;
    this.game.drop();
  }
}
