var Competition = require('../models/Competition'),
	Tournament = require('../models/Tournament'),
	Match = require('../models/Match'),
	_ = require('lodash');


module.exports = function() {
	var CompetitionsCtrl = {
		getAll: getAll,
		get: get,
		getWs: getWs,
		add: add,
		edit: edit,
		remove: remove,
		startCompetition: startCompetition,
		callMatch: callMatch,
		clearCalls: clearCalls,
		selectWinner: selectWinner
	};

	return CompetitionsCtrl;

	function getAll(req, res, next) {
		console.log(req.params)
		Competition
		.find({_tournament: req.params.tournamentId})
		.sort({created: -1})
		.exec(function(err, competition) {
			if(err) return next(err);
			res.json(competition);
		})
	}

	function _getOneById(id, cb) {
		Competition.findById(id)
		.deepPopulate(
			'matches.team1.players matches.team2.players matches.winner.players results.team.players', {
			populate: {
				'matches': {
					options: {
						sort: {
							round: 1,
							order: 1
						}
					}
				},
				'results': {
					options: {
						sort: {
							place: 1,
							date: 1
						}
					}
				}
			}
		})
		.exec(cb);
	}

	function get(req, res, next) {
		_getOneById(req.params.id, function(err, competition) {
			if(err) {
				err.status = 400;
				next(err);
			}
			res.json(competition);
		})
	}

	function getWs(socket) {
		
		socket.on('competitions:get', function(data) {
			var roomName = 'competition ' + data.competitionId;
			// console.log('socket.rooms', socket.rooms);
			_clearRooms(socket);
			socket.join(roomName);
			// console.log('getWs socket', data);

			socket.on('competitions:changed', function(data) {
				_competitionEmit(socket, data.competitionId);
			});

			_competitionEmit(socket, data.competitionId);
		})

	}

	function _clearRooms(socket) {
		var patt = /competition .*/
		_.each(socket.rooms, function(room) {
			if(patt.test(room)) {
				socket.leave(room);
			}
		});
	}

	function _competitionEmit(socket, id) {
		_getOneById(id, function(err, competition) {
			if(err) return new Error('Competition get faild');
			console.log('competition emit');
			// emitujemy do siebie
			socket
			.emit('competitions:competition', competition);
			// emitujemy do wszystkich innyc
			socket
			.broadcast
			.to('competition ' + id)
			.emit('competitions:competition', competition);
			// cb(competition);
		})
		
	}

	function add(req, res, next) {
		// craete tournament
		var competition = new Competition(req.body);
		competition._tournament = req.params.tournamentId;
		competition.save(function(err) {
			if(err) {
				err.status = 400;
				return next(err);
			}
			// add to tournament
			Tournament.findById(req.params.tournamentId, function(err, tournament) {
				tournament.competitions.push(competition);
				tournament.save(function(err) {
					if(err) next(err);
					// success
					res.json({
						success: true,
						competition: competition
					});
				});
			});

		});
	}

	function edit(req, res, next) {
		Competition.findById(req.params.id, function(err, competition) {
			if(err) {
				err.status = 400;
				return next(err);
			}
			competition = _.extend(competition, req.body);
			competition.save(function(err) {
				if(err) {
					err.status = 400;
					return next(err);
				}
				res.json({success: true, competition: competition});
			});
		});
	}

	function remove(req, res, next) {
		// console.log(req.params.id);
		Competition.remove({_id: req.params.id}, function(err) {
			if(err) return next(err);
			res.json({success: true});
		})
	}

	/**
	* start competition
	* req.params.id - competitionId
	* return matches
	*/
	function startCompetition(req, res, next) {
		var competitionId  = req.params.id;

		Competition
		// szukamy competition
		.findById(competitionId)
		// chcemy mieć drużyny razem z graczami, bo później zostaną zwrócone
		.deepPopulate('teams.players')	// deepPopulate - ustawione sortowanie
		.exec(function(err, competition) {
			if(err) return next(err);
			// jak już mamy comeptition
			// usuwamy wszystkie mecze
			deleteCompetitionMatches(competition, function(err) {
				if(err) return next(err);

				// generujemy listę meczy
				matches = generateListOfMatches(competition);
				// zapisujemy każdy
				_.each(matches, function(match) {
					match.save(function(err) {
						if(err) return next(err);
					});
				});
				// dopisujemy mecze do konkurencji
				competition.matches = matches;
				competition.startSize = matches.length;
				competition.results = [];
				competition.start = true;
				competition.save(function(err) {
					// success
					return res.json(matches);
					
				})
			});
		});
		
	}

	/**
	* callMatch
	* req.body.table - table number
	* req.body.matchId - matchID
	* return {success, match}
	*/
	function callMatch(req, res, next) {
		var table = req.body.table || null;
		var matchId = req.body.matchId;
		Match.findById( matchId , function(err, match) {
			if(err || !match || !!match.winner) {
				if(!match) err = {status: 400};
				return next(err);
			}
			match.calls.push({ table: table });
			match.save(function(err) {
				if(err) return next(err);
				// success
				return res.json({
					success: true,
					match: match
				})
			})

		})
	}

	/*
	* clearCalls
	* winner nie może być ustawiony
	* req.body.matchId
	* return success
	*/
	function clearCalls(req, res, next) {
		var matchId = req.body.matchId;
		Match.findById( matchId , function(err, match) {
			if(err || !match || !!match.winner) {
				if(!match) err = {status: 400};
				return next(err);
			}
			match.calls = [];
			match.save(function(err) {
				if(err) return next(err);
				// success
				return res.json({
					success: true
				})
			})

		})
	}


	/**
	* select winner
	*
	*/
	function selectWinner(req, res, next) {
		var matchId = req.body.matchId;
		var winnerId = req.body.winnerId;
		Match.findById(matchId)
		// .populate('team1').populate('team2')
		.populate({
			path: '_competition',
			options: {
				select: {matches: 0, teams: 0}
			}
		})
		.exec(function(err, match) {
			if(err || !match) {
				if(!match) err = {status: 400, message: 'Match not found'};
				return next(err);
			}
			match.winner = winnerId;

			var winner, loser;
			if(match.team1+'' === winnerId+'') {
				winner = match.team1;
				loser = match.team2;
			} else {
				winner = match.team2;
				loser = match.team1;
			}

			// if match.final
			if(match.final) {
				return setFinalFinish(match, winner, loser, next, function() {
					return match.save(function(err) {
						if(err) return next(err);
						res.json({
							success: true
						});
					});

				});

			}

			// zamiast cb można użyć promises
			setMatchWinner(match, winner, next, function(newMatch) {
				console.log('setMatchWinner READY');
				setMatchLoser(match, loser, next, function(newMatch) {
					console.log('setMatchLoser READY');

					// zapisujemy
					match.save(function(err) {
						if(err) return next(err);
						res.json({
							success: true
						});
					});
				});
			});

		});
	}

	function setMatchWinner(match, team, next, cb) {
		if(!team) {
			console.error('setMatchWinner', 'team empty')
			return cb();
		}
		var competition = match._competition;
		if(competition.type === "2KO") {
			console.log(competition.type);
			var newMatch = {
				_competition: match._competition,
				round: null,
				order: null,
				losses: match.losses
			};

			// jeżeli w poprzednim meczu był tylko jeden mecz to przechodzimy do finału
			// tak to działa tylko na prawej stronie
			var goToFinal = false;
			if(match.losses == 0) {
				// jeżeli jesteśmy na stronie wygranych
				// i nie jest to runda pierwsza to przeskakujemy o 3 rundy
				newMatch.round = match.round === 1 ? 2 : match.round + 3;
			} else if(match.losses == 1) {
				// jeżeli jest to strona przegranych
				newMatch.round = match.round + 1;
				//sprawdzamy czy nie wypadła runda wygranych
				while(!!isWinnersRound(newMatch.round)) {
					// jeżeli tak to powiększamy
					newMatch.round++;
				}
				// console.log(getRoundNbOfMatch(competition.startSize, newMatch.round));
				goToFinal = getRoundNbOfMatch(competition.startSize, newMatch.round) == 0.5 ? 1 : 0;
				if(goToFinal) {
					// jeżeli dla rundy ilość meczy to pół tzn, że idziemy do finału
					// czyli musimy cofnąć się o jedną rundę (do rundy wygranych)
					newMatch.round--;
				}
			}
			console.log('goToFinal', goToFinal);
			// jeżeli jesteśm na przegranych i przeskoczyliśmy tylko jedną rundę,
			// to order zostaje taki sam
			// przy finale spełniany jest ten sam warunek
			if(match.losses && match.round + 1 === newMatch.round) {
				newMatch.order = match.order;
			} else {
				// w innym przypadku liczymy połowe poprzedniego ordera zaokrąglonego w górę
				newMatch.order = Math.ceil(match.order/2);
			}
			
			console.log('round', match.round);
			console.log('nextRound', newMatch.round);
			console.log('order', newMatch.order);

			if(goToFinal) {
				// musimy ustawić losses na zero żeby znalazł, lub stworzył, ten sam mecz
				// moglibyśmy wposzukać tylko po competition, order i round, żeby uniknąc tego
				newMatch.losses = 0;
			}

			Match.findOne(newMatch, function(err, findMatch) {
				if(err) return next(err);
				if(findMatch) {
					console.log('Znaleziono')
					newMatch = findMatch;
				} else {
					console.log('Nowy mecz');
					newMatch = new Match(newMatch);
					addMatchToCompetition(competition._id, newMatch._id, next);
				}
				console.log(newMatch.team1+'' === match.team1+'')
				// sprawdzamy czy nie ma gdzieś wypełnionej drużyny, którąś z naszego meczy
				// gdyby byłyo to ustawiamy na null, ponieważ będziemy wprowadzać aktualizację
				if(newMatch.team1+'' == match.team1+'' || newMatch.team1+'' == match.team2+'') {
					console.log('Clear team1')
					newMatch.team1 = null;
				}
				if(newMatch.team2+'' == match.team1+'' || newMatch.team2+'' == match.team2+'') {
					console.log('Clear team2')
					newMatch.team2 = null;
				}


				if(!!newMatch.team1 && !!newMatch.team2) {
					return next({status: 400, message: 'Match has all the teams'});
				}

				// przypisyanie drużyny do nowego meczu
				if(!newMatch.team1 &&  (match.order%2 || !!newMatch.team2)) {
					// jeżeli nieparzyste to winner leci do team1
					// jeżeli newMatch.team2 jest zajęty to też tutaj
					newMatch.team1 = team;
				} else if(!newMatch.team2) {
					// jeżeli parzyste to do team2
					newMatch.team2 = team;
				} else {
					return next({status: 500, message: 'Drużyny nie zostały przypisane'});
				}

				// przypiujemy do finału, że jest finałem - dopiero jak schodzi z lewej strony gracz
				if(goToFinal) {
					newMatch.final = true;
				}

				newMatch.save(function(err) {
					if(err) return next(err);
					cb(newMatch);
				})
				
			})

		}
		// console.log(match._competition)
	}	

	function setMatchLoser(match, team, next, cb) {
		var competition = match._competition;
		if(competition.type === "2KO") {
			if(match.losses > 0) {
				console.log('Gracz odpada')
				return setTeamLoser(competition, match, team, next, function(competition) {
					return cb();
				});
				// można ustawić, że gracz odpada
				// return cb();
			}
			var newMatch = {
				_competition: match._competition,
				round: match.round + 2,	// przegrany zawsze idzie 2 rundy dalej
				order: null,
				losses: match.losses +1
			};

			if(match.round === 1) {
				newMatch.order = Math.ceil(match.order/2);
			} else {
				var roundNbOfMatch = getRoundNbOfMatch(competition.startSize, newMatch.round);
				console.log(newMatch.round, roundNbOfMatch)
				newMatch.order = roundNbOfMatch - match.order+1;
			}

			Match.findOne(newMatch, function(err, findMatch) {
				if(err) return next(err);
				if(findMatch) {
					newMatch = findMatch;
				} else {
					console.log('Nowy mecz');
					newMatch = new Match(newMatch);
					addMatchToCompetition(competition._id, newMatch._id);
				}

				// sprawdzamy czy nie ma gdzieś wypełnionej drużyny, którąś z naszego meczy
				// gdyby byłyo to ustawiamy na null, ponieważ będziemy wprowadzać aktualizację
				if(newMatch.team1+'' == match.team1+'' || newMatch.team1+'' == match.team2+'') {
					newMatch.team1 = null;
				}
				if(newMatch.team2+'' == match.team1+'' || newMatch.team2+'' == match.team2+'') {
					newMatch.team2 = null;
				}


				// przegranego dajemy do team2, chyba że nie jest wolna
				if(!newMatch.team2) {
					newMatch.team2 = team;
				} else {
					newMatch.team1 = team;
				}

				newMatch.save(function(err) {
					if(err) return next(err);
					cb(newMatch);
				});
				
			})

		}
	}

	function setTeamLoser(competition, match, team, next, cb) {
		var place = 0;
		if(!team) {
			return cb(Competition);
		}
		// sprawdza czy drużyna nie jest już w wynikach i usuwa ją
		// usuwa też te wyniki w których nie ma drużyn
		competition.results = _.filter(competition.results, function(item) {
			return (item.team+'' !== team+'') && !!item.team;
		});

		var result = {
			team: team,
			place: countPlace(competition.startSize, match.round)
		}
		// competition.results.push(result);

		competition.results.push(result);
		console.log('results:', competition.results.length);
		competition.save(function(err) {
			if(err) return next(err);
			return cb(competition);
		});
	}

	function setFinalFinish(match, winner, loser, next, cb) {
		var competition = match._competition;
		// powiększamy rundę o jeden i zapisujemy przegranego
		match.round++;
		return setTeamLoser(competition, match, loser, next, function() {
			// powiększamy o kolejną rundę i zapisujemy wygranego (na 1 miejscu)
			match.round++;
			return setTeamLoser(competition, match, winner, next, function() {
				match.round-= 2;
				return cb();
			});
		})
	}

	// private
	function isWinnersRound(round) {
		return !( (round-2)%3);
	}

	// function getPlace(startSize, round) {
	// 	var loseRound = getLoseRound(round);
	// 	var nbOfTeams = startSize *2;

	// 	console.log('loseRound', loseRound);
	// 	return nbOfTeams - (nbOfTeams/(2*loseRound)); // place
	// }

	function countPlace(startSize, round) {
		var sum = 0;
		var nbOfTeams = startSize * 2;
		var matches;
		var i = 3;	// first lose round
		for(; i <= round; i++) {
			if(isWinnersRound(i)) continue;
			console.log(i);
			matches = getRoundNbOfMatch(startSize, i);
			console.log('hmm', matches);
			sum += Math.ceil(matches);
		}
		console.log(sum);
		return nbOfTeams - sum + 1;
	}

	// zwraca numer rundy przegranych
	// function getLoseRound(round) {
	// 	// ilośc rund pomniejszona o ilość cięć, pomniejszona o 1 (na początku sa dwie rundu po prawej)
	// 	return round - Math.ceil((round-1)/3) - 1;
	// }

	// function countPlace(startSize, round) {
	// 	var sum = 0;
	// 	var nbOfTeams = startSize * 2;

	// 	var i = getLoseRound(3);	// first lose round
	// 	for(; i <= getLoseRound(round); i++) {
	// 		var matches = getLoseRoundNbOfMatch(startSize, i);
	// 		console.log('hmm', matches);
	// 		sum += Math.ceil(matches);
	// 	}
	// 	console.log(sum);
	// 	return nbOfTeams - sum;
	// }


	// function getLoseRoundNbOfMatch(startSize, loseRound) {
	// 	var nbOfCuts = Math.ceil(loseRound / 2);
	// 	return startSize / Math.pow(2, nbOfCuts);
	// }

	function getRoundNbOfMatch(startSize, round) {
		// sprwadzamy ile razy doszło do podzielenia liczby meczy
		var nbOfCuts = Math.ceil((round-1)/3);	
		// console.log('cuts', nbOfCuts);
		// console.log('pow', Math.pow(2, nbOfCuts));
		return startSize / //dzielimy ilość początkowych meczy
												 Math.pow(2, nbOfCuts);	// przez potęgę dwójki, gdzie wykładnikiem jest liczba podzieleń ilości meczy
	}

	function deleteCompetitionMatches(competition, cb) {
		return Match.remove({_competition: competition._id}, cb);
	}

	function addMatchToCompetition(competitionId, matchId, next, cb) {
		Competition.findById(competitionId, function(err, competition) {
			if(err) next(err);
			competition.matches.push(matchId);
			competition.save(cb);
		});
	}

	function generateListOfMatches(competition) {
		var matchList = [];
		if(competition.type === "2KO"
			|| competition.type === "1KO") {
			console.log('nb of teams', competition.teams.length);
			// na podstawie special wiem które drużyny z jaką grają (wg rankingu)
			var special = [
				0, 1/2,	// 2 matches
				1/4, 3/4,	// 4 matches
				1/8, 5/8, 3/8, 7/8,	// 8 matches
				1/16, 9/16, 5/16, 13/16, 3/16, 11/16, 7/16, 15/16, // 16 matches
				1/32, 17/32, 25/32, 9/32, 5/32, 21/32, 13/32, 29/32,
				3/32, 19/32, 27/32, 11/32, 7/32, 23/32, 15/32, 31/32 //32 matches
			];
			// ustawienie wielkości drzewka
			var treeSize = 1;
			while(treeSize < competition.teams.length) {
				treeSize*= 2;
			};
			// s -start, e - end; początkowa i końcowa drużyna
			var s = 0,
				e = treeSize-1;
			console.log('treeSize', treeSize);
			// rozstawienie:
			for(var i = 0; i < treeSize/2; i++) {
				var jump = special[i] * treeSize;
				var idx_s = s + jump;
				var idx_e = e - jump;
				console.log(idx_s+1, idx_e+1);	// działa! :D

				var match = new Match({
					_competition: competition._id,
					team1: competition.teams[idx_s] || null,
					team2: competition.teams[idx_e] || null,
					order: matchList.length + 1
				});
				matchList.push(match);
			}
		}

		return matchList;
	}


}();
